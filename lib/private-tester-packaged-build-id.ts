declare const __PRIVATE_TESTER_PACKAGED_BUILD_ID__: unknown;

const BUILD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

// Vite replaces this identifier with Vinext's resolved build ID while packaging
// the worker. It is deliberately not a Worker binding or caller input.
export function privateTesterPackagedBuildId(): string {
  const value = typeof __PRIVATE_TESTER_PACKAGED_BUILD_ID__ === "string" ? __PRIVATE_TESTER_PACKAGED_BUILD_ID__ : "";
  if (!BUILD_ID.test(value)) throw new Error("private tester packaged build identity invalid");
  return value;
}
