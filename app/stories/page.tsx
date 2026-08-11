import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { AppShell } from "@/components/AppShell";
import { requirePageUser } from "@/lib/auth";
import { storyReady } from "@/app/api/v1/stories/production";
import { StoryStudio } from "./StoryStudio";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Create a story", robots: { index: false, follow: false } };

export default async function StoriesPage() {
  await requirePageUser("/stories");
  if (!await storyReady()) notFound();
  return <AppShell active="stories"><StoryStudio /></AppShell>;
}
