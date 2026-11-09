/**
 * A team booking's host who has left the store's team (9 November 2026).
 *
 * The creator's side of a team booking's emails, "New booking" when it is
 * confirmed and "Moved:" when the buyer moves it, carries the buyer's
 * address, their answers, the meeting link and a reply-to the buyer. It went
 * to the booking's first host by the team setup saved for the call, whoever
 * that host is now: somebody taken off the team after the time was held
 * still got it. A new booking already leaves them out (activeTeam reads the
 * team now, through possibleHosts).
 *
 * Checked against the real code, with an in-memory Redis and stand-ins for
 * Stripe and Resend:
 *
 *   - a host removed from the team between the hold and the confirmation
 *     gets neither email; the owner gets both, told why;
 *   - a host still on the team gets both, as before;
 *   - a team that cannot be read (rule 24): the owner only, never the host.
 */
import { addProduct, claimHandle, ensureStatsId, setProductCall, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import type { Product, Store } from "@/lib/store";
import { readListing, readProduct } from "@/lib/catalog";
import { type CallListing, confirmBooking, holdAndCheckout, isConfirmed, moveBooking } from "@/lib/calls";
import { type CallSetup, zonedToUtc } from "@/lib/call-setup";
import type { TeamHost } from "@/lib/team-scheduling-rules";
import { putMember, removeMember, setMemberRole } from "@/lib/team";
import { writeTeam } from "@/lib/team-booking";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NY = "America/New_York";
const ORIGIN = "https://marktmorgen.com";

const sent: { to: string; subject: string; text: string }[] = [];
let sessions = 0;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const method = init?.method ?? "GET";
  const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  if (url.hostname === "api.resend.com") {
    const body = JSON.parse(String(init?.body ?? "{}")) as { to?: string | string[]; subject?: string; text?: string };
    sent.push({ to: String([body.to].flat()[0]).toLowerCase(), subject: String(body.subject ?? ""), text: String(body.text ?? "") });
    return answer({ id: `email_${sent.length}` });
  }
  const path = url.pathname.replace(/^\/v1/, "");
  if (method === "POST" && path === "/checkout/sessions") {
    sessions += 1;
    const id = `cs_test_hostleft${String(sessions).padStart(10, "0")}`;
    return answer({ id, url: `https://checkout.stripe.com/c/pay/${id}` });
  }
  return answer({ object: "list", data: [], has_more: false });
}) as typeof fetch;

// The store's team record (lib/team.ts readTeam) cannot be read while `failTeam` is on; every other command runs as it does.
let failTeam = false;
const run = redis.pipeline;
redis.pipeline = async (commands) => {
  if (failTeam && commands.some((c) => c[0] === "GET" && /^nl:team:[^:]+$/.test(String(c[1])))) throw new Error("Redis request failed with status 503");
  return run(commands);
};

const WEEKDAYS: [number, number][][] = [[], [[540, 1020]], [[540, 1020]], [[540, 1020]], [[540, 1020]], [[540, 1020]], []];
const weekly = {
  kind: "weekly",
  minutes: 60,
  tz: NY,
  weekly: WEEKDAYS,
  noticeHours: 1,
  horizonDays: 30,
  bufferMinutes: 0,
  room: "https://example.com/room",
  video: false,
  meet: null,
  seats: 1,
  sessions: [],
} as unknown as CallSetup;

function host(email: string): TeamHost {
  return { email, tz: NY, weekly: WEEKDAYS, bufferMinutes: 0, noticeHours: 1, dailyCap: 4 };
}

function weekdayAt(days: number, minute: number): number {
  for (let d = days; d < days + 8; d += 1) {
    const day = new Date(Date.now() + d * DAY);
    const p = new Intl.DateTimeFormat("en-US", { timeZone: NY, year: "numeric", month: "2-digit", day: "2-digit", weekday: "short" }).formatToParts(day);
    const get = (t: string) => p.find((x) => x.type === t)?.value ?? "";
    if (get("weekday") === "Sat" || get("weekday") === "Sun") continue;
    return zonedToUtc(Number(get("year")), Number(get("month")), Number(get("day")), minute, NY) as number;
  }
  throw new Error("no weekday");
}

/** A Pro store whose one call is hosted by `member` alone, on the team as `role`. */
async function teamStore(owner: string, handle: string, account: string, member: string, role: "admin" | "editor" | "support"): Promise<{ store: Store; call: CallListing }> {
  await claimHandle(owner, handle, `${handle} studio`, "");
  await ensureStatsId(owner);
  await setStripeAccount(owner, account, true);
  await setSubscription(owner, { customerId: `cus_${handle}00001`, subscriptionId: `sub_${handle}00001`, active: true, tier: "pro", period: paidPeriod() });
  const made = await addProduct(owner, "Strategy call", "", "120", null);
  if (!made.ok) throw new Error("no product");
  await setProductCall(owner, made.product.id, weekly);
  const store = (await storeForEmail(owner)) as Store;
  if (!(await putMember(store, member, role))) throw new Error("no member");
  const call = (await readListing(store, made.product.id)) as CallListing;
  await writeTeam(store, call.id, { mode: "round_robin", hosts: [host(member)], createdAt: "2026-10-06T00:00:00.000Z" });
  return { store, call };
}

async function hold(store: Store, call: CallListing, start: number): Promise<string> {
  const full = (await readProduct(store, call.id)) as Product & { call: CallSetup };
  const held = await holdAndCheckout({ store, product: full, start, buyerTz: NY, origin: ORIGIN });
  if (!held.ok) throw new Error(`no hold: ${held.reason}`);
  return held.session;
}

/** Who got the creator's side of a booking's emails since `from`, the buyer's own left out: [address, subject start]. */
const creatorSide = (from: number, buyer: string) =>
  sent
    .slice(from)
    .filter((m) => m.to !== buyer && (m.subject.startsWith("New booking:") || m.subject.startsWith("Moved:")))
    .map((m) => [m.to, m.subject.split(":")[0]]);

async function confirmAndMove(store: Store, call: CallListing, start: number, buyer: string) {
  const session = await hold(store, call, start);
  return {
    session,
    confirm: () => confirmBooking({ store, product: call, session, start, end: start + HOUR, buyerEmail: buyer, buyerTz: NY, cancel: null, answers: [{ label: "Goal", value: "Private answer" }], origin: ORIGIN }),
    move: () => moveBooking({ store, product: call, session, booked: { start, end: start + HOUR, email: buyer, buyerTz: NY }, start: start + 2 * HOUR, origin: ORIGIN }),
  };
}

async function main(): Promise<void> {
  redis.clear();
  process.env.STRIPE_SECRET_KEY = "sk_test_host_left_only";
  process.env.RESEND_API_KEY = "re_test_a_stand_in_key_for_tests_only";

  part("A host removed from the team after the time was held");
  const harbor = await teamStore("harbor@example.com", "harbor", "acct_1TestHarbor0001", "maya@example.com", "support");
  const h = await confirmAndMove(harbor.store, harbor.call, weekdayAt(9, 600), "lee@example.com");
  is("removed through the team's own removal", await removeMember(harbor.store, "maya@example.com"), true);
  let mark = sent.length;
  await h.confirm();
  is("the booking is still confirmed", await isConfirmed(h.session), true);
  is("New booking goes to the owner, never to the host who left", creatorSide(mark, "lee@example.com"), [["harbor@example.com", "New booking"]]);
  is(
    "the owner is told the host is no longer on the team",
    sent.slice(mark).some((m) => m.subject.startsWith("New booking:") && m.text.includes("maya@example.com is no longer on your team")),
    true,
  );
  mark = sent.length;
  const moved = await h.move();
  is("the move goes through", moved.ok, true);
  is("Moved goes to the owner, never to the host who left", creatorSide(mark, "lee@example.com"), [["harbor@example.com", "Moved"]]);
  is("nothing at all reached the host who left", sent.some((m) => m.to === "maya@example.com"), false);

  part("A host still on the team");
  const quay = await teamStore("quay@example.com", "quay", "acct_1TestQuay00001", "sam@example.com", "admin");
  const q = await confirmAndMove(quay.store, quay.call, weekdayAt(10, 600), "kai@example.com");
  // A new role is still a place on the team, and a new booking still takes them as its host (possibleHosts reads no role).
  is("the role changes", (await setMemberRole(quay.store, "sam@example.com", "editor")).ok, true);
  mark = sent.length;
  await q.confirm();
  await q.move();
  is("New booking and Moved go to the host, as before", creatorSide(mark, "kai@example.com"), [["sam@example.com", "New booking"], ["sam@example.com", "Moved"]]);

  part("A team that cannot be read when the emails go out");
  const pier = await teamStore("pier@example.com", "pier", "acct_1TestPier00001", "noa@example.com", "support");
  const p = await confirmAndMove(pier.store, pier.call, weekdayAt(11, 600), "ivy@example.com");
  mark = sent.length;
  failTeam = true;
  try {
    await p.confirm();
  } finally {
    failTeam = false;
  }
  is("confirmed all the same", await isConfirmed(p.session), true);
  failTeam = true;
  let pierMoved: Awaited<ReturnType<typeof p.move>>;
  try {
    pierMoved = await p.move();
  } finally {
    failTeam = false;
  }
  is("moved all the same", pierMoved.ok, true);
  is("New booking and Moved go to the owner only, never to the host", creatorSide(mark, "ivy@example.com"), [["pier@example.com", "New booking"], ["pier@example.com", "Moved"]]);
  is("nothing reached the host", sent.some((m) => m.to === "noa@example.com"), false);

  done();
}

void main();
