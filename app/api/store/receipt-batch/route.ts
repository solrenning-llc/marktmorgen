import type { NextRequest } from "next/server";
import { countStudio, creatorFrom } from "@/lib/studio-route";
import { DEMO_CONNECTED_ACCOUNT } from "@/lib/demo-account";
import { RECEIPT_BATCH_RESERVE_SECONDS, RECEIPT_BATCH_STOP_SECONDS, receiptRange } from "@/lib/receipt-batch-rules";
import { RECEIPT_BATCH_UNITS, receiptBatch } from "@/lib/receipt-batch";

// The longest one download may run (RECEIPT_BATCH_SECONDS, the shape its studio requests pay for:
// tests/kb22-receipt-batch.test.ts). Reads stop with RECEIPT_BATCH_RESERVE_SECONDS left; nothing is sent past the hard stop.
export const maxDuration = 60;

/**
 * A store's receipts for some days of one month, as one ZIP
 * (lib/receipt-batch.ts, 601 [KB22] U3): `?month=YYYY-MM`, or
 * `?from=YYYY-MM-DD&to=YYYY-MM-DD` inside one month. For a role that may see
 * the store's sales (lib/team-roles.ts, "orders"). The whole download's
 * RECEIPT_BATCH_UNITS studio requests are taken before Stripe is read; the
 * sales are counted before any receipt is read or numbered, and a count past
 * RECEIPT_BATCH_MAX is refused with the count. The file is made on request
 * and kept nowhere; only receipt numbers are kept (lib/receipt-number.ts).
 */
export async function GET(request: NextRequest) {
  const started = Date.now();
  const plain = (status: number, body: string) => new Response(body, { status, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });
  const creator = await creatorFrom(request, "orders");
  if (creator instanceof Response) return creator;
  const range = receiptRange(request.nextUrl.searchParams);
  if (!range.ok) return plain(400, range.message);
  let { store } = creator;
  const account = store.stripeAccountId;
  // Nothing sold on the demo's account is a real sale (lib/house-store.ts).
  if (!account || account === DEMO_CONNECTED_ACCOUNT) return plain(404, `There are no one-time paid sales on this store from ${range.label}.`);
  // The rest of the download's requests, before anything is read from Stripe.
  const counted = await countStudio(store, null, RECEIPT_BATCH_UNITS - 1);
  if (!counted.ok) return plain(429, counted.message);
  if (counted.store) store = counted.store;
  const made = await receiptBatch(store, account, range, {
    now: Date.now,
    readsUntil: started + (maxDuration - RECEIPT_BATCH_RESERVE_SECONDS) * 1000,
    stopAt: started + (maxDuration - RECEIPT_BATCH_STOP_SECONDS) * 1000,
  });
  if (!made.ok) return plain(made.status, made.message);
  return new Response(new Uint8Array(made.zip), {
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="${made.name}"`,
      "Cache-Control": "private, no-store",
      "X-Robots-Tag": "noindex",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
