import type { Metadata } from "next";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { studioPath, studioView } from "@/lib/studio-route";
import { StudioHeader } from "@/components/studio-header";
import { StudioStorePin } from "@/components/studio-store-pin";
import { UtcAndLocal } from "@/components/local-clock";
import { formatMoney } from "@/lib/money";
import { readEarningsYear } from "@/lib/earnings-read";
import { EARNINGS_FILE_NOTICES } from "@/lib/earnings-csv";
import type { Earnings, EarningsMonth, MonthLine, SourceMonth } from "@/lib/earnings-by-month";
import { readsSales } from "@/lib/stats";
import type { Store } from "@/lib/store";
import { HEAVY_READINGS_PER_DAY, READING_FRESH_SECONDS, type Kept, NotRead, ReadingFailed, ReadingsUsed, readingsBackAt, readingsLeft } from "@/lib/store-readings";

export const metadata: Metadata = {
  title: "Earnings by month — Marktmorgen",
  robots: { index: false, follow: false },
};

type Params = { searchParams: Promise<{ [key: string]: string | string[] | undefined }> };

/**
 * 561 [NE1]: Marktmorgen promises no earnings. The sentence of the queue's
 * text, said here because this page shows money; linked to the Terms once
 * their section exists (it does not yet, so no link).
 */
const NO_EARNINGS_PROMISE =
  "Marktmorgen is software for selling your own work. We make no promise that using it will bring you sales, income or any result. What you earn depends on your products, your audience and your work.";

/** The store has no time zone (lib/store.ts), so months are UTC months, said on the page. */
const TIME_ZONE = "UTC";

const NUMBER_WORDS = ["zero", "one", "two", "three", "four", "five"];
const readingsWord = NUMBER_WORDS[HEAVY_READINGS_PER_DAY] ?? String(HEAVY_READINGS_PER_DAY);
const freshMinutes = Math.round(READING_FRESH_SECONDS / 60);

const monthName = (month: string, current: boolean) => {
  const [y, m] = month.split("-").map(Number);
  const name = new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
  return current ? `${name}, so far` : name;
};

/** "US dollars", "euros": the currency's name as a person says it, or its code when unknown. */
const currencyName = (currency: string) => {
  const code = currency.toUpperCase();
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency: code, currencyDisplay: "name" }).formatToParts(2).find((p) => p.type === "currency")?.value ?? code;
  } catch {
    return code;
  }
};

const SOURCE_NAMES = { stripe: "Stripe", paypal: "PayPal" } as const;

/** Money in and money out of a line; a confirmed zero said as "None", never as an unknown. */
const moneyIn = (line: MonthLine) => line.salesCents + line.renewalCents + line.enteredCents;
const moneyOut = (line: MonthLine) => line.refundCents + line.disputeCents;
const amount = (cents: number, currency: string) => (cents === 0 ? "None" : formatMoney(cents, currency));

const readOn = (at: number) => new Date(at).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });

const cell = "py-2.5 pr-4 text-right tabular-nums";
const rowHead = "py-2.5 pr-4 text-left font-semibold";

function Lines({ name, lines }: { name: string; lines: MonthLine[] }) {
  if (!lines.length) {
    return (
      <tr>
        <th scope="row" className={rowHead}>{name}</th>
        <td colSpan={3} className="py-2.5 text-ink-soft">Nothing recorded</td>
      </tr>
    );
  }
  return (
    <>
      {lines.map((line) => (
        <tr key={line.currency}>
          <th scope="row" className={rowHead}>{`${name}, ${currencyName(line.currency)}`}</th>
          <td className={cell}>{amount(moneyIn(line), line.currency)}</td>
          <td className={cell}>{amount(moneyOut(line), line.currency)}</td>
          <td className="py-2.5 text-right font-semibold tabular-nums">{formatMoney(line.netCents, line.currency)}</td>
        </tr>
      ))}
    </>
  );
}

function SourceRows({ source }: { source: SourceMonth }) {
  const name = SOURCE_NAMES[source.source as keyof typeof SOURCE_NAMES];
  if (source.state === "unknown") {
    return (
      <tr>
        <th scope="row" className={rowHead}>{name}</th>
        <td colSpan={3} className="py-2.5 font-semibold">Could not be read</td>
      </tr>
    );
  }
  return <Lines name={name} lines={source.lines} />;
}

/** One month: a table with a row for each source and currency, and the sources together within each currency. */
function Month({ month }: { month: EarningsMonth }) {
  // "Entered by you" is not built yet (BX2 unit 3 of the design): never shown until it works (VR).
  const sources = month.sources.filter((s) => s.source !== "manual");
  const title = monthName(month.month, month.current);
  const id = `month-${month.month}`;
  return (
    <section aria-labelledby={id} className="card mt-6 p-5 sm:p-8">
      <h2 id={id} className="text-lg font-semibold tracking-[-0.02em] text-ink">{title}</h2>
      <div className="mt-4 overflow-x-auto">
        <table className="w-full text-sm">
          <caption className="sr-only">{`${title}: money by source and currency`}</caption>
          <thead>
            <tr className="text-left text-ink-soft">
              <th scope="col" className="py-2 pr-4 font-semibold">Source and currency</th>
              <th scope="col" className="py-2 pr-4 text-right font-semibold">Sales and renewals</th>
              <th scope="col" className="py-2 pr-4 text-right font-semibold">Refunds and disputes</th>
              <th scope="col" className="py-2 text-right font-semibold">Left after refunds and disputes</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {sources.map((source) => (
              <SourceRows key={source.source} source={source} />
            ))}
            {sources.length > 1 ? (
              month.totals ? (
                <Lines name="All sources" lines={month.totals} />
              ) : (
                <tr>
                  <th scope="row" className={rowHead}>All sources</th>
                  <td colSpan={3} className="py-2.5 text-ink-soft">No total, because a source could not be read</td>
                </tr>
              )
            ) : null}
          </tbody>
        </table>
      </div>
    </section>
  );
}

type Reading =
  | { state: "none" }
  | { state: "ok"; kept: Kept<Earnings | null>; used: boolean }
  | { state: "used" }
  | { state: "failed" }
  | { state: "error" };

/**
 * The twelve months, read by readEarningsYear: its kept copy while fresh,
 * otherwise one of the store's HEAVY_READINGS_PER_DAY, taken before Stripe or
 * PayPal is read (lib/store-readings.ts). A store selling through neither
 * reads nothing and takes nothing.
 */
async function read(store: Store): Promise<Reading> {
  if (!readsSales(store)) return { state: "none" };
  try {
    const kept = await readEarningsYear(store, TIME_ZONE);
    if (!kept || !kept.value) return { state: "error" };
    // A copy shown although it is old: say whether the day's readings are used (two GETs, only then).
    const used = kept.stale && !kept.failed ? !(await readingsLeft(store).catch(() => ({ heavy: false }))).heavy : false;
    return { state: "ok", kept, used };
  } catch (error) {
    if (error instanceof ReadingsUsed) return { state: "used" };
    if (error instanceof ReadingFailed) return { state: "failed" };
    if (!(error instanceof NotRead)) console.error("reading the store's earnings failed", error);
    return { state: "error" };
  }
}

/**
 * Earnings by month (426 [BX2]; docs/bx2-earnings-design.md): twelve months
 * of what the creator's own Stripe account and the PayPal sales kept here
 * recorded, by source and by currency, never added across currencies. A
 * month a source could not be read in full says so, with no amount. Nothing
 * ranks or rates the creator by revenue (561 [NE1]). Whoever may see the
 * store's numbers sees it; drawing it is a studio page (STUDIO_PAGE_UNITS,
 * counted by studioView).
 */
export default async function StudioEarningsPage({ searchParams }: Params) {
  const query = await searchParams;
  const found = await studioView(await cookies(), typeof query.store === "string" ? query.store : undefined, "stats");
  if (!found.ok) {
    if (found.reason === "signed_out") redirect("/signin");
    redirect(found.store ? studioPath(found.store, "team=forbidden") : "/studio");
  }
  const { view } = found;
  const { store } = view;
  const reading = await read(store);
  const earnings = reading.state === "ok" ? reading.kept.value : null;
  const payPalLeftOut = Boolean(earnings?.months.some((m) => m.leftOut.some((l) => l.source === "paypal" && l.kinds.includes("dispute"))));
  const backAt = readingsBackAt();
  // Sent back from the download with why no file was made (app/api/store/earnings/route.ts).
  const fileNotice =
    query.file === EARNINGS_FILE_NOTICES.none
      ? "No file was made: none of your earnings were kept for your store to make it from. Nothing was read from Stripe or PayPal for it."
      : query.file === EARNINGS_FILE_NOTICES.unread
        ? "No file was made: your earnings could not be read from the copy kept here. Nothing was read from Stripe or PayPal for it. Try the download again."
        : null;

  return (
    <div className="flex min-h-screen flex-col bg-paper text-ink">
      <StudioHeader current={store} role={view.role} stores={view.stores} owned={view.owned} action={{ href: studioPath(store), label: "Back to the studio", short: "Studio" }} />
      <StudioStorePin sid={store.sid}>
        <main id="content" className="container-page pb-20 pt-10 sm:pt-14">
          <p className="eyebrow">Numbers</p>
          <h1 className="t-h2 mt-3">Earnings by month</h1>
          <div className="mt-3 max-w-2xl space-y-3 text-ink-soft">
            <p>
              What your own Stripe account and the PayPal sales recorded here show for each of the last 12 months: sales and renewals, minus refunds and
              disputes. A dispute counts when a bank took the money back or is holding it while the dispute is open.
            </p>
            <p>These amounts are before Stripe&apos;s and PayPal&apos;s fees and before taxes, so they are not profit.</p>
            <p>Amounts in different currencies are never added together: each currency has its own line.</p>
            <p>Months start and end at midnight UTC (Coordinated Universal Time).</p>
          </div>

          {fileNotice ? (
            <p className="notice notice-info mt-6 max-w-2xl" role="alert">
              {fileNotice}
            </p>
          ) : null}

          {reading.state === "none" ? (
            <p className="notice notice-info mt-6 max-w-2xl" role="status">
              Your store does not take payments through Stripe or PayPal yet, so there are no earnings to read.
            </p>
          ) : (
            <>
              <p className="mt-4 max-w-2xl text-sm text-ink-soft">
                {`Opening this page uses one of today's ${readingsWord} sales readings, unless your earnings were read in the last ${freshMinutes} minutes. The studio home page uses the same ${readingsWord} readings for your sales.`}
              </p>
              {reading.state === "ok" ? (
                <p className="mt-4 max-w-2xl text-sm" role="status">
                  {reading.kept.failed
                    ? "The last reading failed and was counted, so these are the earnings read on "
                    : reading.used
                      ? `Today's ${readingsWord} sales readings are used, so these are the earnings read on `
                      : reading.kept.stale
                        ? "Your earnings could not be read again just now, so these are the ones read on "
                        : "Read on "}
                  {readOn(reading.kept.at)}
                  {" at "}
                  <UtcAndLocal ms={reading.kept.at} />.
                  {reading.used ? (
                    <>
                      {" They can be read again after "}
                      <UtcAndLocal ms={backAt} />.
                    </>
                  ) : null}
                </p>
              ) : (
                <p className="notice notice-info mt-6 max-w-2xl" role="status">
                  {reading.state === "used" ? (
                    <>
                      {`Today's ${readingsWord} sales readings are used, so your earnings could not be read. They can be read again after `}
                      <UtcAndLocal ms={backAt} />.
                    </>
                  ) : reading.state === "failed" ? (
                    `Your earnings could not be read just now. The try was counted as one of today's ${readingsWord} sales readings.`
                  ) : (
                    "Your earnings could not be read just now. Try again later."
                  )}
                </p>
              )}
              {earnings ? (
                <>
                  <div className="mt-4 max-w-2xl space-y-3 text-sm text-ink-soft">
                    <p>
                      “Could not be read” means Stripe or PayPal did not answer in full for that month, or your store has more sales than one reading
                      covers. That month then has no amount, rather than one lower than it really is. The oldest month can say it for Stripe, because a renewal paid
                      then may have been billed before it. “Nothing recorded” means the month was read in full
                      and had no money in or out.
                    </p>
                    {payPalLeftOut ? <p>PayPal disputes are not read, so PayPal amounts do not take them out.</p> : null}
                  </div>
                  {reading.state === "ok" && reading.kept.unkept ? (
                    // Too large to keep (READING_COPY_MAX_BYTES): the file is made from the kept copy only, so it is not offered.
                    <p className="mt-6 max-w-2xl text-sm text-ink-soft" data-earnings-file="unkept">
                      This reading is too large to keep a copy of, usually because your store sells in many currencies, so it cannot be downloaded as a
                      file. Every amount is still shown below.
                    </p>
                  ) : (
                    /* A plain GET form rather than a link, so nothing prefetches it (lib/earnings-csv.ts, 426 [BX2] unit 4). */
                    <form action="/api/store/earnings" method="get" className="mt-6 max-w-2xl">
                      <input type="hidden" name="store" value={store.sid} />
                      <button type="submit" className="btn btn-secondary btn-sm" aria-describedby="earnings-file-help">
                        Download these 12 months (CSV)
                      </button>
                      <p id="earnings-file-help" className="mt-2 text-sm text-ink-soft">
                        A spreadsheet file of the amounts below, one row for each month, source and currency. It has no buyer&apos;s name or email. It is
                        made from this reading, so it does not read Stripe or PayPal again. Downloading it counts as one studio page. If your spreadsheet
                        shows each row in one column, import the file and choose comma as the separator.
                      </p>
                    </form>
                  )}
                  {earnings.months.map((month) => (
                    <Month key={month.month} month={month} />
                  ))}
                </>
              ) : null}
            </>
          )}
          <p className="mt-8 max-w-2xl text-sm text-ink-soft">{NO_EARNINGS_PROMISE}</p>
        </main>
      </StudioStorePin>
    </div>
  );
}
