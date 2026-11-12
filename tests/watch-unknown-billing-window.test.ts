/** A paying store whose billing window is unknown (period not readable) must not move watching to the calendar month: video admission reads the billing window and would never see those seconds (finding F1 of Claude 3 on #3105, proof rev3105-f1). */
import { rememberFolderOwner } from "@/lib/delivery";
import { allowanceWindow, calendarWindow } from "@/lib/allowance-window";
import { claimHandle, setSubscription, storeFolder, storeForEmail } from "@/lib/store";
import { STREAM_API_ORIGIN } from "@/lib/stream-rules";
import { measure, watchedForAdmission, watchedIn } from "@/lib/watch";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";
import { done, is, part } from "./check";

const LIBRARY = "4244";
const COLLECTION = "00000000-0000-4000-8000-00000000c013";
const VIDEO = "00000000-0000-4000-8000-0000000000c1";
/** What the video service says the one video has been watched, in all. */
let total = 0;

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
  if (url.origin === STREAM_API_ORIGIN && url.pathname === `/library/${LIBRARY}/videos` && (init?.method ?? "GET") === "GET") {
    const items = url.searchParams.get("collection") === COLLECTION ? [{ guid: VIDEO, collectionId: COLLECTION, totalWatchTime: total }] : [];
    return json({ totalItems: items.length, currentPage: 1, itemsPerPage: 1000, items });
  }
  return json({}, 404);
}) as typeof fetch;

async function main(): Promise<void> {
  redis.clear();
  process.env.UPSTASH_REDIS_REST_URL ??= "http://stub";
  process.env.BUNNY_STREAM_LIBRARY_ID = LIBRARY;
  process.env.BUNNY_STREAM_API_KEY = "a-stand-in-library-key-for-tests-only";
  process.env.BUNNY_STREAM_TOKEN_KEY = "a-stand-in-token-key-for-tests-only";
  const realError = console.error;
  console.error = () => {};
  const now = Date.now();
  const email = "window@example.com";
  await claimHandle(email, "window", "window", "");
  const period = paidPeriod(now);
  await setSubscription(email, { customerId: "cus_Win0001", subscriptionId: "sub_Win0001", active: true, cycle: "month", period });
  const folder = await storeFolder(email);
  await rememberFolderOwner(folder, email);
  await redis.pipeline([["SET", `nl:stream:col:${folder}`, COLLECTION]]);
  const store = await storeForEmail(email);
  const billing = store ? allowanceWindow(store, now)?.id ?? null : null;
  const calendar = calendarWindow(now).id;
  total = 600;
  is("set up: billing window apart from calendar month", typeof billing === "string" && billing !== calendar, true);
  is("set up: first reading under the billing month", await measure(folder, now), 600);

  part("F1: the store's billing window is unknown (allowanceWindow null): watching must not land in the calendar month");
  // The period is lost from the record (unknown window: a paid store with no period has no window).
  await setSubscription(email, { active: true, period: null });
  const unknown = await storeForEmail(email);
  is("set up: a paid store with no period has no window", unknown ? allowanceWindow(unknown, now) : "no store", null);
  total = 4200;
  is("unknown window: nothing measured this round (null)", await measure(folder, now), null);
  is("nothing added under the calendar month", await watchedIn(folder, calendar), 0);
  // Stripe's period is read back (lib/billing-sync.ts): the same billing window again.
  await setSubscription(email, { active: true, period });
  is("set up: the billing window is known again", (await storeForEmail(email)) ? allowanceWindow((await storeForEmail(email))!, now)?.id : null, billing);
  await measure(folder, now);
  is("the admission's billing window holds every second watched in it", await watchedForAdmission(folder, billing as string), 4200);
  console.error = realError;
  done();
}

void main();
