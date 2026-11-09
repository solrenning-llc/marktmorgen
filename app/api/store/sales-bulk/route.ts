import type { NextRequest } from "next/server";
import { guardStoreWrite, text } from "@/lib/store-request";
import { BULK_SALES_REFUSALS, MAX_BULK_SALES, readReferences } from "@/lib/sales-bulk-rules";
import { bulkResend } from "@/lib/sales-bulk";

/** Seconds this route may run (route segment config): up to MAX_BULK_SALES sales read from Stripe and emailed, one at a time. */
export const maxDuration = 60;

/** The longest body: MAX_BULK_SALES references of at most 220 characters, quoted, and the envelope. */
const BODY_BYTES = 200 + MAX_BULK_SALES * 224;

const headers = { "Cache-Control": "private, no-store" };

/**
 * The purchase email again for several orders of the studio's sales list at once (767 [STN14], unit 4;
 * lib/sales-bulk.ts): `{ action: "resend", references: ["cs_…", …] }`, at most MAX_BULK_SALES. For the same people
 * as one sent again (lib/team-roles.ts "orders": the owner, admins and support), and never from a locked session,
 * as the single resend (app/api/store/resend/route.ts). No action moves money: anything else is refused.
 *
 * Answers what was sent and, for every other order, why not (`couldNot`, `skipped`). The store's emails are counted
 * first: when they cannot be (503) or too few are left (429), nothing is sent.
 */
export async function POST(request: NextRequest) {
  const guarded = await guardStoreWrite(request, "orders", BODY_BYTES, () => "resend");
  if (!guarded.ok) return guarded.response;
  const { store, body } = guarded;
  if (text(body.action, 10) !== "resend") return Response.json({ ok: false, error: "unknown", message: BULK_SALES_REFUSALS.unknown }, { status: 400, headers });
  const asked = readReferences(body.references);
  if (!asked.ok) return Response.json({ ok: false, error: asked.error, message: BULK_SALES_REFUSALS[asked.error] }, { status: 400, headers });
  const result = await bulkResend(store, asked);
  if (!result.ok) {
    return Response.json({ ok: false, error: result.error, message: result.message, ...(result.left !== undefined ? { left: result.left } : {}) }, { status: result.error === "uncounted" ? 503 : 429, headers });
  }
  return Response.json({ ok: true, ...result.tally }, { headers });
}
