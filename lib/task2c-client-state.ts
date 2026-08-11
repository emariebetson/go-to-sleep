export type KeyValueStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function stableStoredRequestId(storage: KeyValueStorage, key: string, create: () => string = () => crypto.randomUUID()) {
  const existing = storage.getItem(key)?.trim().toLowerCase();
  if (existing && UUID_V4.test(existing)) return existing;
  const created = create().trim().toLowerCase();
  if (!UUID_V4.test(created)) throw new Error("A UUID v4 request ID is required.");
  storage.setItem(key, created);
  return created;
}

export function settleStoredRequestId(storage: KeyValueStorage, key: string, status: number) {
  if (status < 500 && status !== 408 && status !== 429) storage.removeItem(key);
}

export function repeatDeadlineForState(now: number, repeatMinutes: number | null, mediaPlaying: boolean) {
  return repeatMinutes && mediaPlaying ? now + repeatMinutes * 60_000 : null;
}

export function storedSecret(storage: KeyValueStorage, key: string, create: () => string) {
  const existing = storage.getItem(key);
  if (existing) return existing;
  const created = create();
  storage.setItem(key, created);
  return created;
}

export function clearStoredSecret(storage: KeyValueStorage, key: string) {
  storage.removeItem(key);
}

type ExportManifestShape = { metadataPages: { count: number }; integrityCatalog?: { count: number }; mediaParts: { count: number } };

export function exportArtifactPlan(exportId: string, manifest: ExportManifestShape) {
  const metadataCount = manifest.metadataPages.count + (manifest.integrityCatalog?.count || 0);
  if (!Number.isSafeInteger(metadataCount) || metadataCount < 0 || !Number.isSafeInteger(manifest.mediaParts.count) || manifest.mediaParts.count < 0) throw new Error("Export manifest counts are invalid.");
  const encodedExport = encodeURIComponent(exportId);
  return [
    { kind: "manifest" as const, id: "manifest", url: `/api/account/export/${encodedExport}` },
    ...Array.from({ length: metadataCount }, (_, position) => ({ kind: "metadata" as const, id: String(position), url: `/api/account/export/${encodedExport}/metadata/${position}` })),
    ...Array.from({ length: manifest.mediaParts.count }, (_, position) => {
      const id = `${exportId}:part:${String(position).padStart(8, "0")}`;
      return { kind: "part" as const, id, url: `/api/account/export/${encodedExport}/parts/${encodeURIComponent(id)}` };
    }),
  ];
}
