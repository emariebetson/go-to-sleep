import { getOAuthAuth } from "@/lib/oauth";

async function handleAuth(request: Request) {
  const configured = process.env.BETTER_AUTH_URL || process.env.PUBLIC_APP_URL;
  const baseURL = configured ? new URL(configured).origin : new URL(request.url).origin;
  return getOAuthAuth(baseURL).handler(request);
}

export const GET = handleAuth;
export const POST = handleAuth;
