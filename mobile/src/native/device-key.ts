// This module deliberately re-exports the only production constructor. The
// private runtime brand is issued in offline-cache.ts after native attestation.
export {loadNativeDeviceKey} from "../offline-cache";
export type {DeviceBoundKey,NativeDeviceKeyHostObject} from "../offline-cache";
