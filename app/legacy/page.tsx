import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { AppShell } from "@/components/AppShell";
import { requirePageUser } from "@/lib/auth";
import { nearLegacyReady } from "@/app/api/v1/legacy/production";
import { LegacyDashboard } from "./LegacyDashboard";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Family archive", robots: { index: false, follow: false } };
export default async function LegacyPage() {
  await requirePageUser("/legacy"); if (!await nearLegacyReady("read")) notFound();
  return <AppShell active="legacy"><LegacyDashboard /></AppShell>;
}
