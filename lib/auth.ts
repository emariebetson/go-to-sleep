import { getSessionCookie } from "better-auth/cookies";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { signInPath } from "@/lib/auth-navigation";

export { safeRelativeReturnPath, signInPath } from "@/lib/auth-navigation";

export type AppUser = {
  userId: string;
  displayName: string;
  email: string;
  fullName: string | null;
};

export type ApiAuthContext = {
  user: AppUser;
  sessionId: string;
  sessionCreatedAt: Date;
};

const previewUser: AppUser = {
  userId: "local-preview",
  email: "preview@nearnight.local",
  displayName: "Preview Parent",
  fullName: "Preview Parent",
};

export async function getAppUser(request?: Request): Promise<AppUser | null> {
  return (await getApiAuthContext(request))?.user || null;
}

export async function getApiAuthContext(request?: Request): Promise<ApiAuthContext | null> {
  const requestHeaders = request ? request.headers : new Headers(await headers());
  if (!getSessionCookie(requestHeaders)) {
    if (process.env.NODE_ENV !== "production" && request) {
      return {
        user: previewUser,
        sessionId: requestHeaders.get("x-nearyou-preview-session-id") || "preview-session",
        sessionCreatedAt: new Date(Number(requestHeaders.get("x-nearyou-preview-session-created-at")) || Date.now()),
      };
    }
    return null;
  }

  const { getOAuthAuth } = await import("@/lib/oauth");
  const session = await getOAuthAuth(requestOrigin(requestHeaders)).api.getSession({ headers: requestHeaders });
  if (!session?.user?.id || !session.user.email) return null;

  const displayName = session.user.name?.trim() || session.user.email;
  return {
    user: {
      userId: session.user.id,
      displayName,
      email: session.user.email,
      fullName: session.user.name?.trim() || null,
    },
    sessionId: session.session.id,
    sessionCreatedAt: new Date(session.session.createdAt),
  };
}

export async function requireApiUser(request: Request): Promise<AppUser> {
  const context = await getApiAuthContext(request);
  if (context) return context.user;

  throw new Response(JSON.stringify({ error: "Please sign in to continue." }), {
    status: 401,
    headers: { "content-type": "application/json" },
  });
}

export async function requireApiAuthContext(request: Request): Promise<ApiAuthContext> {
  const context = await getApiAuthContext(request);
  if (context) return context;
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

export function isAdmin(user: AppUser): boolean {
  const allowed = (process.env.ADMIN_EMAILS || "").split(",").map((email) => email.trim().toLowerCase()).filter(Boolean);
  return allowed.includes(user.email.toLowerCase());
}

export function configuredOAuthProviders() {
  return {
    google: Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET),
  };
}

function requestOrigin(requestHeaders: Headers) {
  const configured = process.env.BETTER_AUTH_URL || process.env.PUBLIC_APP_URL;
  if (configured) return new URL(configured).origin;
  const host = requestHeaders.get("x-forwarded-host") || requestHeaders.get("host") || "localhost:3000";
  const protocol = requestHeaders.get("x-forwarded-proto") || (host.startsWith("localhost") ? "http" : "https");
  return `${protocol}://${host}`;
}
