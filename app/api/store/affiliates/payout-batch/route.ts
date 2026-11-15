import type { NextRequest } from "next/server";
import { creatorFrom } from "@/lib/studio-route";
import { storeForEmail } from "@/lib/store";
import { guardStoreWrite, text } from "@/lib/store-request";
import { MAX_REFERENCE_LENGTH, readBook } from "@/lib/affiliates";
import { type BatchProvider, batchFile, batchTotal, recordBatch } from "@/lib/affiliate-payouts";
import { onTheirWay, payableLines } from "@/lib/paypal-payouts";

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The batch file for everyone the book says is owed something today, in the
 * shape the creator's own provider reads: `?provider=paypal` for PayPal
 * Payouts, anything else for the worksheet that goes into Wise's template or
 * a bank transfer.
 *
 * It carries every affiliate's address, so it is for the owner and an Admin
 * only, like the rest of the export (lib/team-roles.ts, "export"). Nothing is
 * written down by downloading it: a file on disk is not a payment, and the
 * book only says "paid" once the creator confirms they paid.
 */
export async function GET(request: NextRequest) {
  const creator = await creatorFrom(request, "export");
  if (creator instanceof Response) return creator;
  const { store } = creator;
  try {
    // The file names no product (batchFile), so nothing is read for the names.
    const book = await readBook(store, undefined, { titles: false });
    // The file is paid from as it is: while refunds or chargebacks could not
    // be read from Stripe in full, what is owed is not known, so no file is
    // handed out, as "Mark as paid" below and payWithPayPal refuse too.
    if (!book.refundsChecked) {
      return new Response(
        "We could not check every refund and chargeback on your Stripe account just now, so what each affiliate is owed is not settled yet. Reload the affiliates page in a minute and download the file again.",
        { status: 409, headers: { "Cache-Control": "no-store" } },
      );
    }
    // Anyone with a PayPal payment on its way is left out, so nobody is paid twice.
    const lines = payableLines(book, await onTheirWay(store));
    if (!lines.length) {
      return new Response("Nobody is owed anything right now.", { status: 409, headers: { "Cache-Control": "no-store" } });
    }
    const asked = new URL(request.url).searchParams.get("provider");
    const provider: BatchProvider = asked === "paypal" ? "paypal" : "worksheet";
    const day = new Date().toISOString().slice(0, 10);
    const { body, filename } = batchFile(provider, lines, store, day);
    return new Response(body, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    console.error("building the affiliate payout batch failed", error);
    return new Response("Something went wrong on our side. Try again in a moment.", { status: 500 });
  }
}

/**
 * `{ date: "2026-09-30", reference: "PayPal batch 4821" }` — the creator
 * confirming they have just paid the batch in their own provider, which
 * writes one payout per affiliate against what the book says is owed at this
 * moment. A sale refunded between the download and this call is not paid out
 * on, because the book is read again here.
 */
export async function POST(request: NextRequest) {
  const guarded = await guardStoreWrite(request, "settings", 8_000);
  if (!guarded.ok) return guarded.response;
  const body = guarded.body;
  const fail = (error: string, status = 400) => Response.json({ ok: false, error }, { status });

  try {
    const store = await storeForEmail(guarded.ref);
    if (!store) return fail("none");
    if (!store.statsId) return fail("unknown");

    const date = text(body.date, 10);
    if (!DATE.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00Z`))) return fail("date");

    const book = await readBook(store);
    // Refunds are read from Stripe: when that failed, what is owed is not yet
    // known, and writing payouts against a guess is how a book starts lying.
    if (!book.refundsChecked) return fail("refunds", 409);

    const away = await onTheirWay(store);
    const lines = payableLines(book, away);
    if (!lines.length) return fail("nothing", 409);

    const done = await recordBatch(
      store,
      book,
      {
        date,
        reference: text(body.reference, MAX_REFERENCE_LENGTH * 2),
      },
      away,
    );
    return Response.json({
      ok: true,
      written: done.written,
      cents: done.cents,
      total: batchTotal(lines),
      skipped: done.skipped,
    });
  } catch (error) {
    console.error("writing down the affiliate payout batch failed", error);
    return fail("server_error", 500);
  }
}
