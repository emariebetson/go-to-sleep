import { integrationPolicy } from "./platform-release";

const SPOTIFY_API = "https://api.spotify.com/v1";
const YOUTUBE_API = "https://www.googleapis.com/youtube/v3";

export type RightsReceipt = { householdId: string; userId: string; sourceIdHash: string; purpose: "private_adaptation"; audience: "household"; attestedAt: Date; revokedAt: Date | null; version: "media-rights-v1" };

export function spotifyCatalogPlaylistRequest(input: { oauthAccessToken: string; spotifyUserId: string; playlistName: string; catalogUris: string[] }) {
  if (!integrationPolicy("spotify", "create_catalog_playlist").allowed || !input.oauthAccessToken) throw new Error("Spotify OAuth is required.");
  if (!/^spotify:user:[A-Za-z0-9]+$/.test(`spotify:user:${input.spotifyUserId}`) || input.catalogUris.some((uri) => !/^spotify:(track|episode):[A-Za-z0-9]+$/.test(uri))) throw new Error("Only Spotify catalog items are supported.");
  return {
    createUrl: `${SPOTIFY_API}/users/${encodeURIComponent(input.spotifyUserId)}/playlists`,
    authorization: `Bearer ${input.oauthAccessToken}`,
    body: { name: input.playlistName.slice(0, 100), public: false },
    catalogUris: input.catalogUris,
  };
}

export function youtubeMetadataRequest(input: { videoId: string; apiKey: string }) {
  if (!integrationPolicy("youtube", "import_metadata").allowed || !/^[A-Za-z0-9_-]{11}$/.test(input.videoId)) throw new Error("A valid YouTube video ID is required.");
  return `${YOUTUBE_API}/videos?part=snippet,contentDetails,status&id=${encodeURIComponent(input.videoId)}&key=${encodeURIComponent(input.apiKey)}`;
}

export function assertYouTubeAdaptationRights(receipt: RightsReceipt | null, householdId: string, userId: string, sourceIdHash: string) {
  const age = receipt ? Date.now() - receipt.attestedAt.getTime() : Number.POSITIVE_INFINITY;
  if (!receipt || receipt.version !== "media-rights-v1" || receipt.householdId !== householdId || receipt.userId !== userId
    || receipt.sourceIdHash !== sourceIdHash || receipt.purpose !== "private_adaptation" || receipt.audience !== "household"
    || receipt.revokedAt || age < 0 || age > 365 * 24 * 60 * 60 * 1000) {
    throw new Error("A current household rights attestation is required.");
  }
}

export function encryptIntegrationTokenOnlyOnServer() {
  throw new Error("OAuth tokens must be encrypted through the server KMS adapter; plaintext persistence is prohibited.");
}
