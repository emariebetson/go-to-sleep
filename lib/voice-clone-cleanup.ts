export async function retireFailedProviderClone(input: {
  providerVoiceId: string;
  deleteProviderVoice: (providerVoiceId: string) => Promise<boolean>;
  persistCleanup: (providerVoiceId: string) => Promise<void>;
}) {
  let deleted = false;
  try { deleted = await input.deleteProviderVoice(input.providerVoiceId); } catch { /* durable cleanup below */ }
  if (deleted) return { cleanupPending: false } as const;
  await input.persistCleanup(input.providerVoiceId);
  return { cleanupPending: true } as const;
}

export function failedProviderCloneCanBeRetired(input: {
  replacementActivated: boolean;
  replacementProviderVoiceId: string;
  currentVoiceProviderVoiceId?: string | null;
  replacementStatus?: string | null;
}) {
  if (input.replacementActivated) return false;
  if (!input.currentVoiceProviderVoiceId || !input.replacementStatus) return false;
  if (input.currentVoiceProviderVoiceId === input.replacementProviderVoiceId) return false;
  return ["processing", "provider_created", "failed"].includes(input.replacementStatus);
}
