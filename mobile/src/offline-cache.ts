type SecureStoreAdapter = {
  getItemAsync(key: string, options: Record<string, unknown>): Promise<string | null>;
  setItemAsync(key: string, value: string, options: Record<string, unknown>): Promise<void>;
  deleteItemAsync(key: string): Promise<void>;
  whenUnlockedThisDeviceOnly: unknown;
};

const DEVICE_KEY = "nearyou.offline.device-key.v1";

// SecureStore wraps this exportable data key with the OS keystore. A production
// native module must perform AES operations with a non-exportable hardware key;
// this scaffold remains dark until that adapter and device-lock tests exist.
export async function getOrCreateKeystoreWrappedDataKey(store: SecureStoreAdapter, randomBytes: (length: number) => Uint8Array) {
  let key = await store.getItemAsync(DEVICE_KEY, { requireAuthentication: true });
  if (!key) {
    const bytes = randomBytes(32);
    key = Array.from(bytes).map((byte) => byte.toString(16).padStart(2, "0")).join("");
    await store.setItemAsync(DEVICE_KEY, key, { requireAuthentication: true, keychainAccessible: store.whenUnlockedThisDeviceOnly });
    bytes.fill(0);
  }
  return key;
}

export async function purgeOfflineSession(store: SecureStoreAdapter, deleteEncryptedFiles: () => Promise<void>) {
  await deleteEncryptedFiles();
  await store.deleteItemAsync(DEVICE_KEY);
}

export function persistentDownloadMetadata(input: { mediaId: string; checksum: string; accessToken?: string; signedUrl?: string }) {
  return { mediaId: input.mediaId, checksum: input.checksum };
}
