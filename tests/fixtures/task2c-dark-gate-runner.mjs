import assert from "node:assert/strict";

globalThis.__TASK2B_CLOUDFLARE_ENV__ = { DB: new Proxy({}, { get() { throw new Error("0012 DB access while dark"); } }) };
Object.assign(process.env, {
  NEARYOU_ENABLE_FOUNDATION_API: "true",
  NEARYOU_ENABLE_PRODUCTION_UPGRADE_FOUNDATION: "true",
  NEARYOU_ENABLE_NEARSLEEP_PRODUCTION: "true",
  NEARYOU_ENABLE_USAGE_RESERVATIONS: "true",
  NEARYOU_REQUIRE_VERIFIED_VOICE_CONSENT: "true",
  NEARYOU_ENABLE_NEARSLEEP_LIBRARY_PRIVACY: "false",
});

const [{ GET: libraryGet }, { GET: playlistsGet, POST: playlistsPost }, { POST: reauthPost }, { DELETE: accountDelete }] = await Promise.all([
  import("../../app/api/v1/library/route.ts"),
  import("../../app/api/v1/playlists/route.ts"),
  import("../../app/api/account/reauth/route.ts"),
  import("../../app/api/account/route.ts"),
]);
assert.equal((await libraryGet(new Request("https://example.test/api/v1/library"))).status, 404);
assert.equal((await playlistsGet(new Request("https://example.test/api/v1/playlists"))).status, 404);
assert.equal((await playlistsPost(new Request("https://example.test/api/v1/playlists", { method: "POST" }))).status, 404);
assert.equal((await reauthPost(new Request("https://example.test/api/account/reauth", { method: "POST" }))).status, 404);
assert.equal((await accountDelete(new Request("https://example.test/api/account", { method: "DELETE" }))).status, 503);
