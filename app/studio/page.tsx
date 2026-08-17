import type { Metadata } from "next";
import { AppShell } from "@/components/AppShell";
import { requirePageUser } from "@/lib/auth";
import { featureFlagsFromEnv, nearSleepProductionEnabled } from "@/lib/nearyou-foundation";
import { SleepStudio } from "./SleepStudio";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Create a bedtime", robots: { index: false, follow: false } };

export default async function StudioPage() {
  await requirePageUser("/studio");
  const initialProductionMode = nearSleepProductionEnabled(featureFlagsFromEnv(process.env));
  return <AppShell active="studio"><SleepStudio initialProductionMode={initialProductionMode} /></AppShell>;
}
