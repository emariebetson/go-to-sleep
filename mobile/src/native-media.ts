export type NativeMediaPolicy = {
  adultSession: boolean;
  microphoneVisible: boolean;
  backgroundPlayback: boolean;
  offlineEncrypted: boolean;
};

export const NATIVE_MEDIA_POLICY: NativeMediaPolicy = {
  adultSession: true,
  microphoneVisible: true,
  backgroundPlayback: true,
  offlineEncrypted: true,
};

export function assertRecordingAllowed(input: { parentStarted: boolean; microphoneVisible: boolean; childCloneRequested: boolean }) {
  if (!input.parentStarted || !input.microphoneVisible || input.childCloneRequested) throw new Error("Recording is not permitted.");
}
