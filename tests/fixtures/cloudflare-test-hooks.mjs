import { registerHooks } from "node:module";

registerHooks({
  resolve(specifier, context, nextResolve) {
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
