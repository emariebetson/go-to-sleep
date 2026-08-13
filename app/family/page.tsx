import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { AppShell } from "@/components/AppShell";
import { requirePageUser } from "@/lib/auth";
import { FamilyDashboard } from "./FamilyDashboard";
import { nearFamilyPageAvailability } from "./availability";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "NearFamily", robots: { index: false, follow: false } };

export default async function FamilyPage() {
  await requirePageUser("/family");
  const decision = await nearFamilyPageAvailability();
  if (!decision.available) notFound();
  return <AppShell active="family" familyAvailable={decision.available}><FamilyDashboard /></AppShell>;
}
