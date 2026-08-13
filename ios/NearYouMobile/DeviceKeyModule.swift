import Foundation
import Security

// Source scaffold only: the mobile feature flag must remain disabled until this
// protocol is backed by App Attest + Secure Enclave on a signed device build.
@objc protocol DeviceKeyHostObject {
  func attest(_ challenge: String, resolve: @escaping (NSDictionary) -> Void,
              reject: @escaping (String, String, Error?) -> Void)
  func deleteKey(_ resolve: @escaping () -> Void,
                 reject: @escaping (String, String, Error?) -> Void)
}

@objc final class DeviceKeyModule: NSObject, DeviceKeyHostObject {
  func attest(_ challenge: String, resolve: @escaping (NSDictionary) -> Void,
              reject: @escaping (String, String, Error?) -> Void) {
    reject("native_device_key_disabled", "App Attest integration is not enabled", nil)
  }
  func deleteKey(_ resolve: @escaping () -> Void,
                 reject: @escaping (String, String, Error?) -> Void) {
    reject("native_device_key_disabled", "Secure Enclave integration is not enabled", nil)
  }
}
