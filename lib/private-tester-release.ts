const RELEASE_ID = /^rel_[A-Za-z0-9_-]{8,100}$/;
const COMMIT_SHA = /^[a-f0-9]{40}$/;
const SITES_VERSION = /^appgprj_[A-Za-z0-9_-]+~appgver_[A-Za-z0-9_-]+$/;
const WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const START_GRACE_MS = 5 * 60 * 1000;
const RELEASE_KEYS = ["releaseId", "commitSha", "sitesVersion", "startsAt", "expiresAt", "products"];

export type PrivateTesterRelease = {
  releaseId: string;
  commitSha: string;
  sitesVersion: string;
  startsAt: string;
  expiresAt: string;
  products: ["nearfamily", "nearstory"];
};

function isExactRelease(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Object.values(descriptors).some((descriptor) => !Object.hasOwn(descriptor, "value") || descriptor.get || descriptor.set)) return false;
  const keys = Object.keys(value).sort();
  return keys.length === RELEASE_KEYS.length && keys.every((key, index) => key === [...RELEASE_KEYS].sort()[index]);
}

export function parsePrivateTesterRelease(input: unknown, nowMs: number): PrivateTesterRelease {
  if (!Number.isSafeInteger(nowMs) || !isExactRelease(input)) throw new Error("private tester release invalid");
  const { releaseId, commitSha, sitesVersion, startsAt, expiresAt, products } = input;
  if (typeof releaseId !== "string" || !RELEASE_ID.test(releaseId) || typeof commitSha !== "string" || !COMMIT_SHA.test(commitSha) || typeof sitesVersion !== "string" || !SITES_VERSION.test(sitesVersion) || typeof startsAt !== "string" || typeof expiresAt !== "string" || !Array.isArray(products) || products.length !== 2 || products[0] !== "nearfamily" || products[1] !== "nearstory") throw new Error("private tester release invalid");
  const startsAtMs = Date.parse(startsAt);
  const expiresAtMs = Date.parse(expiresAt);
  if (!Number.isSafeInteger(startsAtMs) || !Number.isSafeInteger(expiresAtMs) || startsAtMs < nowMs - START_GRACE_MS || expiresAtMs - startsAtMs !== WINDOW_MS || expiresAtMs - nowMs > WINDOW_MS) throw new Error("private tester release invalid");
  return { releaseId, commitSha, sitesVersion, startsAt, expiresAt, products: ["nearfamily", "nearstory"] };
}
