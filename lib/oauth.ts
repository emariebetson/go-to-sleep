import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { betterAuth } from "better-auth/minimal";
import { getDb } from "@/db";
import { authSessions, authVerifications, oauthAccounts, users } from "@/db/schema";

const instances = new Map<string, ReturnType<typeof betterAuth>>();

export function getOAuthAuth(baseURL: string) {
  const existing = instances.get(baseURL);
  if (existing) return existing;

  const googleEnabled = Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
  const socialProviders = {
    ...(googleEnabled ? {
      google: {
        clientId: process.env.GOOGLE_CLIENT_ID!,
        clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
        scope: ["openid", "email", "profile"],
        prompt: "select_account" as const,
      },
    } : {}),
  };

  const auth = betterAuth({
    appName: "Nearnight",
    baseURL,
    basePath: "/api/auth",
    secret: process.env.BETTER_AUTH_SECRET,
    database: drizzleAdapter(getDb(), {
      provider: "sqlite",
      transaction: false,
      schema: {
        user: users,
        session: authSessions,
        account: oauthAccounts,
        verification: authVerifications,
      },
    }),
    socialProviders,
    user: {
      fields: { name: "displayName" },
    },
    account: {
      encryptOAuthTokens: true,
      accountLinking: {
        enabled: true,
        trustedProviders: ["google"],
        allowDifferentEmails: false,
      },
    },
    session: {
      expiresIn: 60 * 60 * 24 * 30,
      updateAge: 60 * 60 * 24,
      freshAge: 60 * 60 * 24,
    },
    advanced: {
      useSecureCookies: baseURL.startsWith("https://"),
      database: { generateId: "uuid" },
    },
  });

  instances.set(baseURL, auth);
  return auth;
}
