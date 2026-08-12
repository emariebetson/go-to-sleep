import type { Metadata } from "next";
import { headers } from "next/headers";
import "./globals.css";

export async function generateMetadata(): Promise<Metadata> {
  const requestHeaders = await headers();
  const candidateHost = requestHeaders.get("x-forwarded-host") || requestHeaders.get("host") || "nearnight.app";
  const host = /^[a-z0-9.-]+(?::\d+)?$/i.test(candidateHost) ? candidateHost : "nearnight.app";
  const protocol = host.startsWith("localhost") ? "http" : "https";
  const metadataBase = new URL(`${protocol}://${host}`);
  return {
    metadataBase,
    applicationName: "NearSleep by NearYou",
    title: { default: "NearSleep — Your voice, their gentlest bedtime", template: "%s · NearSleep" },
    description: "Create calming, personalized bedtime audio for your baby in the voice they know best—yours.",
    openGraph: {
      title: "NearSleep — Your voice, their gentlest bedtime",
      description: "Personalized baby bedtime stories in a parent's familiar voice.",
      type: "website",
      images: [{ url: new URL("/og.png", metadataBase), width: 1200, height: 630, alt: "NearSleep — Your voice. Their gentlest bedtime." }],
    },
    twitter: { card: "summary_large_image", images: [new URL("/og.png", metadataBase)] },
    other: {
      "nearyou-umbrella": "NearYou",
      "nearyou-product-family": "NearSleep",
      "nearyou-compatible-product": "Nearnight",
      "nearyou-api-version": "v1",
    },
  };
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
