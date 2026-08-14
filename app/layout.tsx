import type { Metadata } from "next";
import "./globals.css";

export function generateMetadata(): Metadata {
  const metadataBase = new URL("https://nearyoustill.com");
  return {
    metadataBase,
    applicationName: "NearYou Still",
    title: { default: "NearYou Still — Near you, still.", template: "%s · NearYou Still" },
    description: "Thoughtful tools that help families keep comfort, stories, connection, and memories near.",
    openGraph: {
      title: "NearYou Still — Near you, still.",
      description: "Thoughtful tools for the moments families choose to keep close.",
      type: "website",
      siteName: "NearYou Still",
      images: [{ url: new URL("/og-nearyoustill.png", metadataBase), width: 1200, height: 630, alt: "NearYou Still — Near you, still." }],
    },
    twitter: { card: "summary_large_image", images: [new URL("/og-nearyoustill.png", metadataBase)] },
    other: {
      "nearyou-umbrella": "NearYou",
      "nearyou-public-namespace": "NearYouStill",
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
