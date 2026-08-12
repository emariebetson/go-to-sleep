import { registerHooks } from "node:module";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (["@/lib/product-release-readiness-service", "./product-release-readiness-service"].includes(specifier) && process.env.NEARYOU_TEST_AUTHORIZED_PRODUCT_ROLLOUT === "true") {
      return {
        shortCircuit: true,
        url: "data:text/javascript,export const createPostgresHouseholdProductAccess=()=>async()=>true;export const createPostgresRolloutFence=()=>async()=>({releaseId:'rel_authorized_fixture',version:1})",
      };
    }
    if (specifier === "cloudflare:workers") {
      return {
        shortCircuit: true,
        url: "data:text/javascript,export const env = globalThis.__TASK2B_CLOUDFLARE_ENV__",
      };
    }
    if (specifier === "next/headers") {
      return { shortCircuit: true, url: "data:text/javascript,export async function headers(){return new Headers()}" };
    }
    if (specifier === "next/navigation") {
      return { shortCircuit: true, url: "data:text/javascript,export function redirect(path){throw new Error('redirect:'+path)}" };
    }
    return nextResolve(specifier, context);
  },
});
