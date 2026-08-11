export function stripeSecretMatchesMode(secret: string, testModeOnly: boolean) {
  if (!/^(?:sk|rk)_(?:test|live)_/.test(secret)) return false;
  return !testModeOnly || /^(?:sk|rk)_test_/.test(secret);
}

export function stripeEventMatchesMode(livemode: boolean, testModeOnly: boolean) {
  return !testModeOnly || !livemode;
}
