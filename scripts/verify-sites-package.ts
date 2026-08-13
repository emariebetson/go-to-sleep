import { readdirSync } from "node:fs";

function sqlNames(directory: URL) {
  try { return readdirSync(directory).filter(name => name.endsWith(".sql")).sort(); }
  catch { return []; }
}

export function verifySitesMigrationMirror() {
  const source = sqlNames(new URL("../drizzle/", import.meta.url));
  const built = sqlNames(new URL("../dist/.openai/drizzle/", import.meta.url));
  if (JSON.stringify(source) !== JSON.stringify(built)) throw new Error("Sites migration archive drift");
  return Object.freeze({ migrationCount: source.length });
}
