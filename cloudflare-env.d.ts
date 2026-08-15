declare namespace Cloudflare {
  interface Env {
    DB: D1Database;
    AUDIO: R2Bucket;
    VERSION_METADATA: { id: string; tag: string; timestamp: string };
    PRIVATE_TESTER_BASELINE_OIDC_SUBJECT: string;
    PRIVATE_TESTER_BASELINE_RELEASE_JSON: string;
    PRIVATE_TESTER_SCHEDULER_ENABLED: "false";
  }
}
