import type { NextRequest } from "next/server";
import { who } from "./affiliate-payout-batch-route-world";
/** The signed-in owner of tests/affiliate-payout-batch-matches-file.test.ts writing; everything else is the real lib/store-request.ts. */
export * from "../lib/store-request";
export async function guardStoreWrite(request: NextRequest) {
  const body = (await request.json()) as Record<string, unknown>;
  return { ok: true as const, email: who.store!.email, ref: who.store!.email, store: who.store!, role: "owner" as const, body };
}
