import { desc, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { usageLedger } from "@/db/schema";
import { apiV1Failure, requireHouseholdContext } from "@/lib/api-v1-context";
import { jsonNoStore } from "@/lib/http";

export async function GET(request: Request) {
  try {
    const { householdId } = await requireHouseholdContext(request, "usage:read");
    const entries = await getDb().select({
      id: usageLedger.id,
      product: usageLedger.product,
      operation: usageLedger.operation,
      quantity: usageLedger.quantity,
      weightMilliunits: usageLedger.weightMilliunits,
      direction: usageLedger.direction,
      createdAt: usageLedger.createdAt,
    }).from(usageLedger).where(eq(usageLedger.householdId, householdId))
      .orderBy(desc(usageLedger.createdAt)).limit(100).all();
    return jsonNoStore({ apiVersion: "v1", entries });
  } catch (error) {
    return apiV1Failure(error, "Usage could not be loaded.");
  }
}
