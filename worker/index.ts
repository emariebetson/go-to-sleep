/** Cloudflare Worker entry point for the vinext-starter template. */
import { handleImageOptimization, DEFAULT_DEVICE_SIZES, DEFAULT_IMAGE_SIZES } from "vinext/server/image-optimization";
import handler from "vinext/server/app-router-entry";
import { featureFlagsFromEnv, nearSleepLibraryPrivacyEnabled } from "@/lib/nearyou-foundation";

interface Env {
  ASSETS: Fetcher;
  DB: D1Database;
  AUDIO: R2Bucket;
  NEARYOU_ENABLE_FOUNDATION_API?: string;
  NEARYOU_ENABLE_PRODUCTION_UPGRADE_FOUNDATION?: string;
  NEARYOU_ENABLE_NEARSLEEP_PRODUCTION?: string;
  NEARYOU_ENABLE_USAGE_RESERVATIONS?: string;
  NEARYOU_REQUIRE_VERIFIED_VOICE_CONSENT?: string;
  NEARYOU_ENABLE_NEARSLEEP_LIBRARY_PRIVACY?: string;
  NEARYOU_ENABLE_NEARSLEEP_LIBRARY_RECONCILIATION?: string;
  NEARYOU_ENABLE_STORY?: string;
  IMAGES: {
    input(stream: ReadableStream): {
      transform(options: Record<string, unknown>): {
        output(options: { format: string; quality: number }): Promise<{ response(): Response }>;
      };
    };
  };
}

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

// Image security config. SVG sources with .svg extension auto-skip the
// optimization endpoint on the client side (served directly, no proxy).
// To route SVGs through the optimizer (with security headers), set
// dangerouslyAllowSVG: true in next.config.js and uncomment below:
// const imageConfig: ImageConfig = { dangerouslyAllowSVG: true };

const worker = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/_vinext/image") {
      const allowedWidths = [...DEFAULT_DEVICE_SIZES, ...DEFAULT_IMAGE_SIZES];
      return handleImageOptimization(request, {
        fetchAsset: (path) => env.ASSETS.fetch(new Request(new URL(path, request.url))),
        transformImage: async (body, { width, format, quality }) => {
          const result = await env.IMAGES.input(body).transform(width > 0 ? { width } : {}).output({ format, quality });
          return result.response();
        },
      }, allowedWidths);
    }

    const response = await handler.fetch(request, env, ctx);
    const secured = new Response(response.body, response);
    secured.headers.set("x-content-type-options", "nosniff");
    secured.headers.set("x-frame-options", "DENY");
    secured.headers.set("referrer-policy", "strict-origin-when-cross-origin");
    secured.headers.set("permissions-policy", "camera=(), geolocation=(), microphone=(self), payment=(self)");
    secured.headers.set("content-security-policy", "default-src 'self'; base-uri 'self'; frame-ancestors 'none'; form-action 'self' https://checkout.stripe.com; img-src 'self' data:; media-src 'self' blob:; connect-src 'self'; font-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; object-src 'none'");
    if (url.protocol === "https:") secured.headers.set("strict-transport-security", "max-age=31536000; includeSubDomains");
    return secured;
  },
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    const task2cEnabled = nearSleepLibraryPrivacyEnabled(featureFlagsFromEnv(env as unknown as Record<string, string | undefined>));
    const migrationReconciliationEnabled = env.NEARYOU_ENABLE_NEARSLEEP_LIBRARY_RECONCILIATION === "true";
    const storyEnabled = env.NEARYOU_ENABLE_STORY === "true";
    if (!task2cEnabled && !migrationReconciliationEnabled && !storyEnabled) return;
    ctx.waitUntil((async () => {
      if (task2cEnabled || migrationReconciliationEnabled) {
        const [{ reconcileHouseholdExports }, { reconcilePendingSessionDeletions, reconcilePendingDeletionReconciliations }, { reconcilePendingAccountDeletions }, { reconcileLegacyReadyMedia }] = await Promise.all([
          import("@/lib/nearsleep-export"), import("@/lib/nearsleep-deletion-reconciliation"), import("@/app/api/account/production"), import("@/lib/nearsleep-storage-reconciliation"),
        ]);
        await reconcileLegacyReadyMedia({ bucket: env.AUDIO as never, limit: 2 });
        if (task2cEnabled) { await reconcileHouseholdExports({ bucket: env.AUDIO as never, limit: 10 }); await reconcilePendingSessionDeletions({ bucket: env.AUDIO, limit: 10 }); await reconcilePendingDeletionReconciliations({ bucket: env.AUDIO, limit: 10, actionLimit: 2 }); await reconcilePendingAccountDeletions(10); }
      }
      if (storyEnabled) {
        const [{ advanceNextNearStoryStage, reconcileExhaustedNearStoryJobs, reconcileStoryCheckpointCleanup }, { reconcilePendingStoryDeletions }, { getDb }, { nearStoryActivationState }, { eq }] = await Promise.all([
          import("@/lib/nearstory-stage-worker"), import("@/lib/nearstory-deletion"), import("@/db"), import("@/db/schema"), import("drizzle-orm"),
        ]);
        const heartbeat = new Date(); await getDb().update(nearStoryActivationState).set({ workerHeartbeatAt: heartbeat, checkedAt: heartbeat }).where(eq(nearStoryActivationState.id, "parent-beta"));
        await advanceNextNearStoryStage();
        await reconcileExhaustedNearStoryJobs(5);
        await reconcileStoryCheckpointCleanup(20);
        await reconcilePendingStoryDeletions({ bucket: env.AUDIO, limit: 5 });
      }
    })());
  },
};

export default worker;
