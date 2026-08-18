import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { SITES_D1_PHASE_A_ARTIFACT } from "../lib/sites-d1-phase-a-artifact.generated";
import { SITES_D1_PHASE_B_ARTIFACT } from "../lib/sites-d1-phase-b-artifact.generated";
import { SITES_D1_PHASE_C_ARTIFACT } from "../lib/sites-d1-phase-c-artifact.generated";
import { SITES_D1_FORWARD_ARTIFACT } from "../lib/sites-d1-forward-artifact.generated";

const PROVIDER_IDS = [
  "0000_nearnight_foundation", "0001_google_apple_auth", "0002_sharp_shinobi_shaw",
  "0003_white_groot", "0004_salty_sugar_man", "0005_pronunciation_frequency_layers",
  "0006_nearyou_shared_foundation",
] as const;

export async function verifyPrivateTesterD1LiveState() {
  const provider = await Promise.all(PROVIDER_IDS.map(async (id) => ({
    id,
    checksum: createHash("sha256").update(await readFile(new URL(`../drizzle/${id}.sql`, import.meta.url))).digest("hex"),
  })));
  const repaired = [
    ...SITES_D1_PHASE_A_ARTIFACT.migrations,
    ...SITES_D1_PHASE_B_ARTIFACT.migrations,
    ...SITES_D1_PHASE_C_ARTIFACT.migrations,
    ...SITES_D1_FORWARD_ARTIFACT.migrations,
  ].map(({ id, sha256 }) => ({ id, checksum: sha256 }));
  const sources = [...provider, ...repaired];
  if (sources.length !== 27 || new Set(sources.map(({ id }) => id)).size !== 27 || sources.some(({ id }, index) => Number(id.slice(0, 4)) !== index)) throw new Error("private tester D1 live state invalid");
  const checkpoint = SITES_D1_FORWARD_ARTIFACT.schemaCheckpoints.find(({ head }) => head === "0026");
  if (!checkpoint) throw new Error("private tester D1 live state invalid");
  return { sources, sourceHash: createHash("sha256").update(JSON.stringify(sources)).digest("hex"), schemaObjectCount: checkpoint.objectCount, schemaDefinitionHash: checkpoint.definitionsSha256 };
}
