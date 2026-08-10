import type { Metadata } from "next";
import { AppShell } from "@/components/AppShell";
import { requirePageUser } from "@/lib/auth";
import { SleepStudio } from "./SleepStudio";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Create a bedtime", robots: { index: false, follow: false } };

export default async function StudioPage() {
  await requirePageUser("/studio");
  return <AppShell active="studio"><SleepStudio /></AppShell>;
}
