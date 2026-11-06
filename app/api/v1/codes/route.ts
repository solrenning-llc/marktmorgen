import { apiAdder, apiError, apiOk, apiStore, apiWriter, takeMoreApi } from "@/lib/api-guard";
import { apiOkFields, badFields } from "@/lib/api-fields";
import { apiReadUnits, codeMakeWork, codeScheduleWork, codeStopWork, codesWork } from "@/lib/api-read-rules";
import { CODE_FIELDS, codeOut, codesOut, readScheduleAsked, refusalWords } from "@/lib/api-codes";
import { createCode, listCodes, stopCode } from "@/lib/discount";
import { type CodeAsked, readCodeAsked } from "@/lib/discount-input";
import { SCHEDULE_PROBLEMS, SCHEDULE_UNITS, type ScheduleEntry, type ScheduleWindow } from "@/lib/discount-schedule-rules";
import { dropSchedule, readSchedules, scheduleCode } from "@/lib/discount-schedule";
import { takeAllowance } from "@/lib/store-allowance";
import { setHasDiscounts, storeRef, type Store } from "@/lib/store";
import { canSell } from "@/lib/store-checkout";

/**
 * Discount codes on the creator's own Stripe account (lib/api-codes.ts):
 *   GET    /api/v1/codes            every code, as the studio lists them
 *   POST   /api/v1/codes            { code, percent } or { code, kind: "amount", amount }, with uses and minimum optional,
 *                                   and starts_at with ends_at (ISO 8601 with its offset) for a code set to start later
 *   DELETE /api/v1/codes?id=promo_… switches one of this store's codes off
 * Writing needs a key that writes. While the store is not taking payments,
 * 409 not_selling, as in the studio.
 *
 * A code set to start later (511 [CK3], unit 3) is the studio's own schedule
 * (lib/discount-schedule.ts): made switched off on the creator's Stripe
 * account with Stripe's expiry as its end, and switched on by the five-minute
 * job. The job's tries are paid as in the studio, SCHEDULE_UNITS studio
 * requests, taken with the call's own API requests before Stripe is asked.
 * Every answer says where each code stands (`state`, and `starts_at` while it
 * waits), and the schedules are read exactly: an unreadable one is 502, never
 * a waiting code shown as simply off.
 */
const notSelling = () => apiError(409, "not_selling", "This store is not taking payments, so it has no discount codes to use.");
const unreadable = () => apiError(502, "unavailable", "Your discount codes could not be read from Stripe just now. Try again in a moment.");
const selling = (store: Store) => Boolean(store.stripeAccountId) && canSell(store);

export async function GET(request: Request) {
  const store = await apiStore(request);
  if (store instanceof Response) return store;
  if (!selling(store)) return notSelling();
  // A ?fields= that cannot be answered is refused before any further request is taken or anything read.
  const bad = badFields(request, CODE_FIELDS);
  if (bad) return bad;
  // One page of the creator's Stripe account and the store's schedules, taken before either is read (lib/api-read-rules.ts, codesWork).
  const refused = await takeMoreApi(store, apiReadUnits(codesWork()));
  if (refused) return refused;
  try {
    const list = await listCodes(store.stripeAccountId as string);
    const kept = await readSchedules(store.statsId);
    return list.state === "ok" && kept.ok ? apiOkFields(request, { data: codesOut(list.codes, kept.schedules) }) : unreadable();
  } catch (error) {
    console.error("api: codes failed", error);
    return unreadable();
  }
}

export async function POST(request: Request) {
  const writer = await apiAdder(request);
  if (writer instanceof Response) return writer;
  const { store, body } = writer;
  if (!selling(store)) return notSelling();
  const read = readCodeAsked(body, store.currency);
  if (!read.ok) return apiError(400, read.reason, refusalWords(read, store.currency));
  const now = Math.floor(Date.now() / 1000);
  const schedule = readScheduleAsked(body, now);
  if (!schedule.ok) return apiError(400, schedule.error, schedule.message);
  if (schedule.window) return scheduled(store, read.asked, schedule.window, now);
  const { code, off, maxRedemptions, minimum } = read.asked;
  // Two calls to the creator's Stripe account, taken before either is made (lib/api-read-rules.ts, codeMakeWork).
  const refused = await takeMoreApi(store, apiReadUnits(codeMakeWork()));
  if (refused) return refused;
  try {
    const made = await createCode(store.stripeAccountId as string, code, off, maxRedemptions, minimum);
    if (!made.ok) {
      return made.reason === "taken"
        ? apiError(409, "taken", "Your Stripe account already has a code with these letters. Choose another.")
        : apiError(502, "unavailable", "The code could not be made on Stripe just now. Try again in a moment.");
    }
    await setHasDiscounts(storeRef(store), true);
    return apiOk({ data: codeOut(made.code) });
  } catch (error) {
    console.error("api: making a code failed", error);
    return apiError(502, "unavailable", "The code could not be made on Stripe just now. Try again in a moment.");
  }
}

/** A code set to start later (511 [CK3]): every request taken, then the studio's own schedule. */
async function scheduled(store: Store, asked: CodeAsked, window: ScheduleWindow, now: number): Promise<Response> {
  // The call's own work (the two calls that make the code, the one that would switch it off again, the lock and
  // the schedule written), then the job's tries as the studio pays them, both before Stripe is asked anything.
  const refused = await takeMoreApi(store, apiReadUnits(codeScheduleWork()));
  if (refused) return refused;
  // Taken from the store's studio requests as the studio takes them (the same figure and window), without the
  // studio's sign-in, which an API key does not have.
  const paid = await takeAllowance(store, "studio", SCHEDULE_UNITS);
  if (!paid.ok) {
    return paid.reason === "used"
      ? apiError(429, "studio_limit", `A code set to start later takes ${SCHEDULE_UNITS} of your store's studio requests, one for each try to switch it on, more than your store has left. ${paid.message}`.trim())
      : apiError(429, paid.reason === "pool" ? "no_place" : "unavailable", paid.message);
  }
  try {
    const made = await scheduleCode(store, asked, window, now);
    if (!made.ok) {
      switch (made.reason) {
        case "full":
          return apiError(409, "schedule_full", SCHEDULE_PROBLEMS.full);
        case "busy":
          return apiError(409, "busy", SCHEDULE_PROBLEMS.busy);
        case "taken":
          return apiError(409, "taken", "Your Stripe account already has a code with these letters. Choose another.");
        default:
          return apiError(502, "unavailable", "The code could not be set to start on Stripe just now. Try again in a moment.");
      }
    }
    const entry: ScheduleEntry = { id: made.code.id, code: asked.code, start: window.start, end: window.end, tries: 0, failed: false };
    return apiOk({ data: codeOut(made.code, entry, now) });
  } catch (error) {
    console.error("api: scheduling a code failed", error);
    return apiError(502, "unavailable", "The code could not be set to start on Stripe just now. Try again in a moment.");
  }
}

export async function DELETE(request: Request) {
  const writer = await apiWriter(request);
  if (writer instanceof Response) return writer;
  const { store } = writer;
  if (!selling(store)) return notSelling();
  const id = new URL(request.url).searchParams.get("id") ?? "";
  if (!/^promo_[A-Za-z0-9]{1,200}$/.test(id)) return apiError(400, "id", "Give the code's id, from GET /api/v1/codes.");
  // The codes read to find it, the call that switches it off and the codes read again and sent, at their most,
  // taken before Stripe is asked (lib/api-read-rules.ts, codeStopWork).
  const refused = await takeMoreApi(store, apiReadUnits(codeStopWork()));
  if (refused) return refused;
  try {
    const account = store.stripeAccountId as string;
    // Only a code the store's own list shows, never any id on the account.
    const before = await listCodes(account);
    if (before.state !== "ok") return unreadable();
    if (!before.codes.some((c) => c.id === id)) return apiError(404, "not_found", "No discount code of this store has that id.");
    // A code waiting for its start loses its schedule first, so the five-minute job never switches it back on.
    const dropped = await dropSchedule(store, id);
    if (dropped === "busy") return apiError(409, "busy", SCHEDULE_PROBLEMS.busy);
    if (dropped !== "done") return unreadable();
    if (!(await stopCode(account, id))) return apiError(502, "unavailable", "The code could not be switched off on Stripe just now. Try again in a moment.");
    // Listed again, so the answer is what Stripe says now; the checkout's box stays only while a code is live.
    const after = await listCodes(account);
    const kept = await readSchedules(store.statsId);
    if (after.state !== "ok" || !kept.ok) return unreadable();
    await setHasDiscounts(storeRef(store), after.codes.some((c) => c.active));
    return apiOk({ data: codesOut(after.codes, kept.schedules) });
  } catch (error) {
    console.error("api: switching a code off failed", error);
    return unreadable();
  }
}
