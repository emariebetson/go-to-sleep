import { getOAuthAuth } from "@/lib/oauth";
import { canonicalAuthRedirect } from "@/lib/oauth-origin";

async function handleAuth(request: Request) {
  const configured = process.env.BETTER_AUTH_URL || process.env.PUBLIC_APP_URL;
  const baseURL = configured ? new URL(configured).origin : new URL(request.url).origin;
  const redirect = canonicalAuthRedirect(request, baseURL);
  if (redirect) return redirect;
  return getOAuthAuth(baseURL).handler(request);
}

export const GET = handleAuth;
export const POST = handleAuth;
