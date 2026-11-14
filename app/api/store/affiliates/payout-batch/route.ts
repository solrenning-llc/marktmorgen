import type { NextRequest } from "next/server";
import { creatorFrom } from "@/lib/studio-route";
import { storeForEmail } from "@/lib/store";
import { guardStoreWrite, text } from "@/lib/store-request";
import { MAX_REFERENCE_LENGTH, readBook } from "@/lib/affiliates";
import { type BatchProvider, batchFile, batchTotal } from "@/lib/affiliate-payouts";
import { confirmPayFile, keepPayFileLocked, onTheirWay, payableLines } from "@/lib/paypal-payouts";
import { LockBusyError } from "@/lib/redis-lock";

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The batch file for everyone the book says is owed something today, in the
 * shape the creator's own provider reads: `?provider=paypal` for PayPal
 * Payouts, anything else for the worksheet that goes into Wise's template or
 * a bank transfer.
 *
 * It carries every affiliate's address, so it is for the owner and an Admin
 * only, like the rest of the export (lib/team-roles.ts, "export"). Nothing is
 * written down as paid by downloading it: a file on disk is not a payment, and
 * the book only says "paid" once the creator confirms they paid. What the file
 * pays is kept under its own id (keepPayFile, named in the X-Payout-File
 * header), so the confirmation writes down exactly that and nothing earned
 * since; when it cannot be kept, no file is handed out.
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
    let file: string;
    try {
      file = await keepPayFileLocked(store, lines);
    } catch (error) {
      if (!(error instanceof LockBusyError)) throw error;
      return new Response("Payments to your affiliates are being written down right now. Download the file again in a minute.", {
        status: 409,
        headers: { "Cache-Control": "no-store" },
      });
    }
    return new Response(body, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Cache-Control": "no-store",
        "X-Payout-File": file,
      },
    });
  } catch (error) {
    console.error("building the affiliate payout batch failed", error);
    return new Response("Something went wrong on our side. Try again in a moment.", { status: 500 });
  }
}

/**
 * `{ date: "2026-09-30", reference: "PayPal batch 4821", file: "<id>" }` — the
 * creator confirming they have just paid one downloaded file in their own
 * provider. It writes down exactly what that file paid each affiliate
 * (confirmPayFile), never what the book says is owed now: a sale made after
 * the download was not in the file, nobody sent it, and it stays owed for the
 * next file. A file not kept (never downloaded, already written down, run out)
 * writes nothing and says so; so does a confirmation while an automatic PayPal
 * payout is being written for the store, and so does a file overlapping a
 * PayPal payment on its way or a payout written since ("stale"). `left` is what
 * the next file would pay after it (payableLines), when the book could be read.
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

    const done = await confirmPayFile(store, text(body.file, 48), {
      date,
      reference: text(body.reference, MAX_REFERENCE_LENGTH * 2),
    });
    if (!done.ok) return fail(done.reason, 409);

    // What the next file would pay, from the book read again: shown to the creator, never written anywhere.
    const [book, away] = await Promise.all([readBook(store).catch(() => null), onTheirWay(store).catch(() => null)]);
    const left = book && away ? batchTotal(payableLines(book, away)) : null;
    return Response.json({ ok: true, written: done.written, cents: done.cents, skipped: done.skipped, left });
  } catch (error) {
    console.error("writing down the affiliate payout batch failed", error);
    return fail("server_error", 500);
  }
}
