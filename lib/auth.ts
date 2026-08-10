import { getSessionCookie } from "better-auth/cookies";
import { headers } from "next/headers";
import { redirect } from "next/navigation";

export type AppUser = {
  userId: string;
  displayName: string;
  email: string;
  fullName: string | null;
};

const previewUser: AppUser = {
  userId: "local-preview",
  email: "preview@nearnight.local",
  displayName: "Preview Parent",
  fullName: "Preview Parent",
};

export async function getAppUser(request?: Request): Promise<AppUser | null> {
  const requestHeaders = request ? request.headers : new Headers(await headers());
  if (!getSessionCookie(requestHeaders)) return null;

  const { getOAuthAuth } = await import("@/lib/oauth");
  const session = await getOAuthAuth(requestOrigin(requestHeaders)).api.getSession({ headers: requestHeaders });
  if (!session?.user?.id || !session.user.email) return null;

  const displayName = session.user.name?.trim() || session.user.email;
  return {
    userId: session.user.id,
    displayName,
    email: session.user.email,
    fullName: session.user.name?.trim() || null,
  };
}

export async function requireApiUser(request: Request): Promise<AppUser> {
  const user = await getAppUser(request);
  if (user) return user;

  if (process.env.NODE_ENV !== "production") return previewUser;

  throw new Response(JSON.stringify({ error: "Please sign in to continue." }), {
    status: 401,
    headers: { "content-type": "application/json" },
  });
}

export async function requirePageUser(returnTo: string): Promise<AppUser> {
  const user = await getAppUser();
  if (user) return user;
  if (process.env.NODE_ENV !== "production") return previewUser;
  redirect(signInPath(returnTo));
}

export function signInPath(returnTo = "/studio") {
  return `/sign-in?returnTo=${encodeURIComponent(safeRelativeReturnPath(returnTo))}`;
}

export function safeRelativeReturnPath(value: string) {
  if (!value.startsWith("/") || value.startsWith("//")) return "/studio";
  try {
    const url = new URL(value, "https://nearnight.local");
    if (url.origin !== "https://nearnight.local" || url.pathname.startsWith("/api/auth") || url.pathname === "/sign-in") return "/studio";
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return "/studio";
  }
}

export function isAdmin(user: AppUser): boolean {
  const allowed = (process.env.ADMIN_EMAILS || "").split(",").map((email) => email.trim().toLowerCase()).filter(Boolean);
  return allowed.includes(user.email.toLowerCase());
}

export function configuredOAuthProviders() {
  return {
    google: Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET),
    apple: Boolean(process.env.APPLE_CLIENT_ID && process.env.APPLE_CLIENT_SECRET),
  };
}

function requestOrigin(requestHeaders: Headers) {
  const configured = process.env.BETTER_AUTH_URL || process.env.PUBLIC_APP_URL;
  if (configured) return new URL(configured).origin;
  const host = requestHeaders.get("x-forwarded-host") || requestHeaders.get("host") || "localhost:3000";
  const protocol = requestHeaders.get("x-forwarded-proto") || (host.startsWith("localhost") ? "http" : "https");
  return `${protocol}://${host}`;
}
