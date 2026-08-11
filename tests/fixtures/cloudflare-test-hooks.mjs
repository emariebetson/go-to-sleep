import { registerHooks } from "node:module";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "cloudflare:workers") {
      return {
        shortCircuit: true,
        url: "data:text/javascript,export const env = globalThis.__TASK2B_CLOUDFLARE_ENV__",
      };
    }
    return nextResolve(specifier, context);
  },
});
