import { getChatGPTUser, requireChatGPTUser, type ChatGPTUser } from "@/app/chatgpt-auth";

export type AppUser = ChatGPTUser;

const previewUser: AppUser = {
  userId: "local-preview",
  email: "preview@nearnight.local",
  displayName: "Preview Parent",
  fullName: "Preview Parent",
};

export async function getAppUser(): Promise<AppUser | null> {
  return getChatGPTUser();
}

export async function requireApiUser(): Promise<AppUser> {
  const user = await getAppUser();
  if (user) return user;

  if (process.env.NODE_ENV !== "production") {
    return previewUser;
  }

  throw new Response(JSON.stringify({ error: "Please sign in to continue." }), {
    status: 401,
    headers: { "content-type": "application/json" },
  });
}

export async function requirePageUser(returnTo: string): Promise<AppUser> {
  const user = await getAppUser();
  if (user) return user;
  if (process.env.NODE_ENV !== "production") return previewUser;
  return requireChatGPTUser(returnTo);
}

export function isAdmin(user: AppUser): boolean {
  const allowed = (process.env.ADMIN_EMAILS || "").split(",").map((email) => email.trim().toLowerCase()).filter(Boolean);
  return allowed.includes(user.email.toLowerCase());
}
