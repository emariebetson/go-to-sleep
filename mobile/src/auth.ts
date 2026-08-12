export type MobileAuthProvider = "google" | "apple";

export function availableMobileAuthProviders(platform: "ios" | "android"): MobileAuthProvider[] {
  return platform === "ios" ? ["google", "apple"] : ["google"];
}

export function validateAuthCallback(url: URL, expectedState: string, expectedNonce: string) {
  if (url.protocol !== "https:" || url.hostname !== "nearyou.example" || url.pathname !== "/mobile/auth/callback") throw new Error("Invalid claimed authentication link.");
  if (!expectedState || url.searchParams.get("state") !== expectedState) throw new Error("Authentication state mismatch.");
  const code = url.searchParams.get("code");
  if (!code || !expectedNonce || url.searchParams.get("nonce") !== expectedNonce) throw new Error("Authentication code or nonce is missing.");
  return code;
}
