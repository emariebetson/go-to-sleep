package com.nearyou.family

// Source scaffold only. The production flag stays disabled until this bridge is
// connected to StrongBox/Android Keystore and verified Play Integrity evidence.
class DeviceKeyModule {
  fun attest(challenge: String): Map<String, Any> {
    require(challenge.isNotBlank())
    throw IllegalStateException("native_device_key_disabled")
  }
  fun deleteKey(): Nothing = throw IllegalStateException("native_device_key_disabled")
}
