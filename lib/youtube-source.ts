import { fetchWithTimeout } from "./http";

export type YouTubeSource = {
  url: string;
  title: string;
  creator: string;
};

const VIDEO_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/;

export function canonicalYouTubeUrl(value: unknown) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("Enter a valid YouTube link.");
  }
  if (url.protocol !== "https:") throw new Error("YouTube links must use https.");
  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  let videoId = "";
  if (host === "youtu.be") videoId = url.pathname.split("/").filter(Boolean)[0] || "";
  if (host === "youtube.com" || host === "m.youtube.com") {
    if (url.pathname === "/watch") videoId = url.searchParams.get("v") || "";
    else {
      const [kind, id] = url.pathname.split("/").filter(Boolean);
      if (["shorts", "embed", "live"].includes(kind)) videoId = id || "";
    }
  }
  if (!VIDEO_ID_PATTERN.test(videoId)) throw new Error("Enter a link to a single YouTube video.");
  return `https://www.youtube.com/watch?v=${videoId}`;
}

function cleanMetadata(value: unknown, limit: number) {
  return String(value || "").replace(/[<>\r\n]/g, " ").replace(/\s+/g, " ").trim().slice(0, limit);
}

export async function resolveYouTubeSource(value: unknown): Promise<YouTubeSource | null> {
  const url = canonicalYouTubeUrl(value);
  if (!url) return null;
  const endpoint = new URL("https://www.youtube.com/oembed");
  endpoint.searchParams.set("url", url);
  endpoint.searchParams.set("format", "json");
  const response = await fetchWithTimeout(endpoint.toString(), { headers: { accept: "application/json" } }, 10_000);
  if (!response.ok) throw new Error("That YouTube video could not be found or is not publicly available.");
  const payload = await response.json() as { title?: string; author_name?: string };
  const title = cleanMetadata(payload.title, 160);
  const creator = cleanMetadata(payload.author_name, 100);
  if (!title) throw new Error("That YouTube video did not include a usable title.");
  return { url, title, creator };
}
