/**
 * 641 [WG1], Claude 6's review of #2912 (MEDIUM, money): free days given to a
 * membership that is already paid for (lib/member-free-days.ts) set its
 * trial_end, so Stripe reads it "trialing" for the rest of the period already
 * paid, not only for the days given. Every reader that took "trialing" for a
 * free trial then said the wrong thing: a switch of tier showed nothing due
 * today, its receipt hid what Stripe charged and the creator was told the
 * member was in their free trial; the subscriptions page counted a paying
 * member as one in a trial.
 *
 * What is checked, with Stripe and the sender faked through fetch and Redis
 * in memory (synthetic only):
 *
 *   - the reviewer's proof first: a switch's preview before the days (control)
 *     and after them;
 *   - the days mark the membership as paid before (or as a free trial, when it
 *     was one), on the same request that moves the date;
 *   - while given days run on a paid membership, no switch of tier and no move
 *     to yearly is offered or made: nothing shows $0, nothing is charged;
 *   - a "trialing" membership that carries free days but no mark cannot be told
 *     apart, so it is not taken for a free trial either (unknown fails closed);
 *   - a real free trial, and one given more days, is still a free trial;
 *   - the subscriptions page's numbers and the person's page read the paid
 *     membership as paying, with its real trial's end, if it had one.
 */
import { addProduct, claimHandle, ensureStatsId, setProductLink, setStoreTiers, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { choicesFor, liveTiers, previewSwitch, switchTier } from "@/lib/tier-switch";
import { membershipsFor, requestManageLink } from "@/lib/membership-manage";
import { giveFreeDays } from "@/lib/member-free-days";
import { askFits, yearlyChoice } from "@/lib/yearly-switch-rules";
import { numbersFrom, readSub } from "@/lib/membership-numbers";
import { membershipWords } from "@/lib/buyer-words/membership";
import { LANGUAGES } from "@/lib/store-language";
import * as profile from "@/lib/buyer-profile";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";
import { TEST_CONSENT } from "./digital-consent-fixture";

const DAY = 86_400;
const NOW = Math.floor(Date.now() / 1000);
const PERIOD_END = NOW + 20 * DAY;
const OWNER = "wg1-not-trial@example.com";
const MEMBER = "dana@example.com";

const emails: { to: string | string[]; text: string; subject: string }[] = [];
const calls: { method: string; path: string; body: URLSearchParams }[] = [];
let tierA = "";
/** The member's one membership, as Stripe holds it; the free days' update changes it as Stripe would. */
let member: Record<string, unknown> = {};
const fresh = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: "sub_Member0001",
  status: "active",
  customer: "cus_Member0001",
  created: NOW - 90 * DAY,
  start_date: NOW - 90 * DAY,
  trial_end: null,
  currency: "usd",
  metadata: { store: "harbor", product: tierA },
  items: { data: [{ id: "si_Member0001", quantity: 1, current_period_end: PERIOD_END, price: { unit_amount: 1000, currency: "usd", metadata: {}, recurring: { interval: "month", interval_count: 1 } } }] },
  ...over,
});

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  if (url.hostname === "api.resend.com") {
    emails.push(JSON.parse(String(init?.body)));
    return new Response(JSON.stringify({ id: `e${emails.length}` }));
  }
  const path = url.pathname.replace(/^\/v1/, "");
  const method = init?.method ?? "GET";
  const body = new URLSearchParams(init?.body ? String(init.body) : "");
  calls.push({ method, path, body });
  const json = (v: unknown) => new Response(JSON.stringify(v));
  if (method === "GET" && path === "/customers") return json({ object: "list", data: url.searchParams.get("email") === MEMBER ? [{ id: "cus_Member0001", created: 1 }] : [] });
  if (method === "GET" && path === "/customers/cus_Member0001") return json({ id: "cus_Member0001", email: MEMBER });
  if (method === "GET" && path === "/subscriptions") return json({ object: "list", has_more: false, data: url.searchParams.get("customer") === "cus_Member0001" ? [member] : [] });
  if (method === "GET" && path.startsWith("/products")) return json({ object: "list", data: [] });
  if (method === "POST" && path === "/prices") return json({ id: "price_Tier00000001" });
  if (method === "POST" && path === "/invoices/create_preview") {
    // Stripe's next invoice: the switch's prorations, and the renewal at the period's end.
    const at = Number(body.get("subscription_details[proration_date]"));
    return json({
      total: 3000,
      currency: "usd",
      starting_balance: 0,
      lines: {
        object: "list",
        has_more: false,
        data: [
          { amount: -500, parent: { subscription_item_details: { proration: true } }, period: { start: at } },
          { amount: 1500, parent: { subscription_item_details: { proration: true } }, period: { start: at } },
          { amount: 2000, parent: { subscription_item_details: { proration: false } }, period: { start: PERIOD_END } },
        ],
      },
    });
  }
  if (method === "POST" && path === "/subscriptions/sub_Member0001") {
    if (body.get("items[0][price]")) {
      // The switch, paid: Stripe charges the card $10.00.
      return json({ id: "sub_Member0001", pending_update: null, items: { data: [{ id: "si_Member0001", price: { id: body.get("items[0][price]") } }] }, metadata: body.get("metadata[dc]") ? { dc: body.get("metadata[dc]") } : {}, latest_invoice: { id: "in_Paid0001", status: "paid", total: 1000, amount_paid: 1000, currency: "usd" } });
    }
    if (body.get("trial_end")) {
      // The free days: Stripe sets the trial's end, reads the membership "trialing" and keeps the metadata sent.
      const meta = { ...(member.metadata as Record<string, string>) };
      for (const [key, value] of body) {
        const m = /^metadata\[(.+)\]$/.exec(key);
        if (!m) continue;
        if (value === "") delete meta[m[1]];
        else meta[m[1]] = value;
      }
      member = { ...member, status: "trialing", trial_end: Number(body.get("trial_end")), metadata: meta };
      return json(member);
    }
    return json({ id: "sub_Member0001" });
  }
  return new Response(JSON.stringify({ error: { message: `no stand-in for ${method} ${path}` } }), { status: 404 });
}) as typeof fetch;

async function main(): Promise<void> {
  redis.clear();
  process.env.STRIPE_SECRET_KEY = "sk_test_wg1_not_trial_only";
  process.env.RESEND_API_KEY = "re_test_a_stand_in_key_for_tests_only";

  await claimHandle(OWNER, "harbor", "Harbor Kitchen", "");
  await ensureStatsId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestHarbor0001", true);
  await setSubscription(OWNER, { customerId: "cus_Owner00001", subscriptionId: "sub_Owner00001", active: true, period: paidPeriod() });
  const monthly = { interval: "month" as const, trialDays: 0, payments: 0 };
  const a = await addProduct(OWNER, "Basic", "", "10", monthly);
  const b = await addProduct(OWNER, "Pro", "", "20", monthly);
  if (!a.ok || !b.ok) throw new Error("no products");
  await setProductLink(OWNER, a.product.id, "https://example.com/basic");
  await setProductLink(OWNER, b.product.id, "https://example.com/pro");
  tierA = a.product.id;
  await setStoreTiers(OWNER, [a.product.id, b.product.id]);
  const store = (await storeForEmail(OWNER))!;
  const tiers = await liveTiers(store);
  const by = { who: OWNER, role: "owner" as const };
  member = fresh();

  is("the member's link is emailed", await requestManageLink({ store, email: MEMBER, ip: "203.0.113.9", origin: "https://marktmorgen.com" }), "sent");
  const token = /token=([0-9a-f]{64})/.exec(emails.at(-1)!.text)![1];

  part("The reviewer's proof: a paid membership given one free day");
  const control = await previewSwitch(store, token, "sub_Member0001", b.product.id);
  is("control, before the days: Stripe's figure is due, not a trial", control.ok ? [control.preview.due, control.preview.trialing] : control.reason, [1000, false]);
  const given = await giveFreeDays(store, MEMBER, "sub_Member0001", 1, PERIOD_END, by);
  is("one free day given", given.ok ? given.nextCharge : given.reason, PERIOD_END + DAY);
  is("Stripe now reads it trialing until the new date", [member.status, member.trial_end], ["trialing", PERIOD_END + DAY]);
  const days = calls.filter((c) => c.path === "/subscriptions/sub_Member0001" && c.body.get("trial_end")).at(-1)!.body;
  is("the same request marks it as paid before the days, with no earlier trial", [days.get("metadata[free_days_paid]"), days.get("metadata[free_days_trial_was]")], ["1", "0"]);

  const listed = (await membershipsFor(store, token))!;
  is("its page offers no switch of tier while the given days run", choicesFor(store, listed[0], tiers), []);
  const after = await previewSwitch(store, token, "sub_Member0001", b.product.id);
  is("a switch's preview is refused, never $0 as a free trial, and says when it opens", after.ok ? [after.preview.due, after.preview.trialing] : [after.reason, waitsUntil(after)], ["waiting", PERIOD_END + DAY]);
  const sent = calls.length;
  emails.length = 0;
  const made = await switchTier(store, token, "sub_Member0001", b.product.id, Math.floor(Date.now() / 1000), TEST_CONSENT);
  is("and the switch itself is refused: nothing is charged", made.ok ? made.title : made.reason, "gone");
  is("no price change sent to Stripe, no receipt, no 'free trial' note to the creator", [calls.slice(sent).filter((c) => c.body.get("items[0][price]")).length, emails.length, emails.some((e) => e.text.includes("free trial"))], [0, 0, false]);

  part("Moving to yearly, the same");
  const club = { id: "club", priceCents: 2000, recurring: { interval: "month", trialDays: 0, payments: 0 }, options: [], pwyw: null, yearly: { cents: 20000 } };
  const yearlySub = (over: Record<string, unknown>) => fresh({ metadata: { store: "harbor", product: "club" }, items: { data: [{ id: "si_Y", quantity: 1, current_period_end: PERIOD_END, price: { unit_amount: 2000, currency: "usd", metadata: {}, recurring: { interval: "month", interval_count: 1 } } }] }, ...over });
  is("a real trial may move to yearly (control)", yearlyChoice(yearlySub({ status: "trialing" }), club, [], "usd", NOW)?.cents, 20000);
  is(
    "given days on a paid membership, or days with no mark: not offered",
    [
      yearlyChoice(yearlySub({ status: "trialing", metadata: { store: "harbor", product: "club", free_days: "1", free_days_paid: "1" } }), club, [], "usd", NOW),
      yearlyChoice(yearlySub({ status: "trialing", metadata: { store: "harbor", product: "club", free_days: "1" } }), club, [], "usd", NOW),
    ],
    [null, null],
  );
  is("days given on a real trial: still a trial, offered", yearlyChoice(yearlySub({ status: "trialing", metadata: { store: "harbor", product: "club", free_days: "3", free_days_paid: "0" } }), club, [], "usd", NOW)?.cents, 20000);

  is(
    "the email offering yearly counts the payments from the real start, not from the days' end",
    [
      askFits(yearlySub({ start_date: NOW - 90 * DAY, trial_end: NOW - 10 * DAY, metadata: { store: "harbor", product: "club", free_days: "5", free_days_paid: "1", free_days_trial_was: "0" } }), NOW),
      askFits(yearlySub({ start_date: NOW - 90 * DAY, trial_end: NOW - 10 * DAY }), NOW),
    ],
    [true, false],
  );

  part("Unknown fails closed: free days with no mark");
  member = fresh({ status: "trialing", trial_end: PERIOD_END + 5 * DAY, metadata: { store: "harbor", product: tierA, free_days: "5" } });
  const unmarked = await previewSwitch(store, token, "sub_Member0001", b.product.id);
  is("not taken for a free trial: no $0, no switch", unmarked.ok ? [unmarked.preview.due, unmarked.preview.trialing] : [unmarked.reason, waitsUntil(unmarked)], ["waiting", PERIOD_END + 5 * DAY]);

  part("A real free trial is still one");
  member = fresh({ status: "trialing", trial_end: NOW + 5 * DAY });
  const trial = await previewSwitch(store, token, "sub_Member0001", b.product.id);
  is("a checkout's trial: nothing due now, said as a trial (control)", trial.ok ? [trial.preview.due, trial.preview.trialing] : trial.reason, [0, true]);
  const more = await giveFreeDays(store, MEMBER, "sub_Member0001", 3, NOW + 5 * DAY, by);
  is("given 3 more days", more.ok, true);
  const trialDays = calls.filter((c) => c.path === "/subscriptions/sub_Member0001" && c.body.get("trial_end")).at(-1)!.body;
  is("marked as a free trial, not paid before", [trialDays.get("metadata[free_days_paid]"), trialDays.get("metadata[free_days_trial_was]")], ["0", null]);
  const longer = await previewSwitch(store, token, "sub_Member0001", b.product.id);
  is("still a trial: nothing due now", longer.ok ? [longer.preview.due, longer.preview.trialing] : longer.reason, [0, true]);
  is("its page still offers the switch", choicesFor(store, (await membershipsFor(store, token))![0], tiers).map((c) => c.title), ["Pro"]);

  part("Days given again on a paid membership keep its first mark");
  member = fresh({ status: "trialing", trial_end: PERIOD_END + DAY, metadata: { store: "harbor", product: tierA, free_days: "1", free_days_paid: "1", free_days_trial_was: String(NOW - 60 * DAY) } });
  const again = await giveFreeDays(store, MEMBER, "sub_Member0001", 2, PERIOD_END + DAY, by);
  is("given 2 more", again.ok, true);
  const againBody = calls.filter((c) => c.path === "/subscriptions/sub_Member0001" && c.body.get("trial_end")).at(-1)!.body;
  is("still paid before, with the real trial's end kept, not the days' own", [againBody.get("metadata[free_days_paid]"), againBody.get("metadata[free_days_trial_was]")], ["1", String(NOW - 60 * DAY)]);
  // A later period (the claim on PERIOD_END is still held from the first press above, as it should be).
  const LATER = PERIOD_END + 30 * DAY;
  member = fresh({ status: "active", trial_end: NOW - 40 * DAY });
  (member.items as { data: Record<string, unknown>[] }).data[0].current_period_end = LATER;
  is("given 2 days on a paid membership that had a trial once", (await giveFreeDays(store, MEMBER, "sub_Member0001", 2, LATER, by)).ok, true);
  const firstBody = calls.filter((c) => c.path === "/subscriptions/sub_Member0001" && c.body.get("trial_end")).at(-1)!.body;
  is("a paid membership that had a trial once: that trial's end is kept", [firstBody.get("metadata[free_days_paid]"), firstBody.get("metadata[free_days_trial_was]")], ["1", String(NOW - 40 * DAY)]);

  part("The subscriptions page's numbers and the person's page");
  const handles = new Set(["harbor"]);
  const paidDays = fresh({ status: "trialing", trial_end: PERIOD_END + DAY, metadata: { store: "harbor", product: tierA, free_days: "1", free_days_paid: "1", free_days_trial_was: "0" } });
  const realTrial = fresh({ id: "sub_Trial00001", status: "trialing", trial_end: NOW + 5 * DAY, start_date: NOW - 2 * DAY });
  const read = [readSub(paidDays as never, handles)!, readSub(realTrial as never, handles)!];
  is("read as paying with no trial, and the real trial as a trial", read.map((s) => [s.status, s.trialEnd]), [["active", 0], ["trialing", NOW + 5 * DAY]]);
  const numbers = numbersFrom(read, "usd", NOW);
  is("one paying ($10 a month), one in a free trial", [numbers.paying, numbers.trialing, numbers.mrr], [1, 1, 1000]);
  const ended = readSub(fresh({ status: "active", trial_end: PERIOD_END + DAY, metadata: { store: "harbor", product: tierA, free_days: "1", free_days_paid: "1", free_days_trial_was: String(NOW - 50 * DAY) } }) as never, handles)!;
  is("after the days, its trial's end is the real one, not the days'", ended.trialEnd, NOW - 50 * DAY);
  const status = (profile as unknown as { membershipStatus?: (sub: Record<string, unknown>) => string }).membershipStatus;
  is(
    "the person's page: paying, not 'In a free trial'; a real trial still one",
    typeof status === "function" ? [status(paidDays), status(realTrial), status(fresh({ status: "trialing", metadata: { store: "harbor", free_days: "2" } }))] : "missing",
    ["active", "trialing", "active"],
  );

  part("A member moved from another platform (Claude 5 on #2912): paid there until its first charge, not a free trial");
  // lib/store-checkout.ts: subscription_data[trial_end] is the first charge and metadata[moved] is "yes",
  // so Stripe reads it "trialing" until then, for a period the member already paid on the other platform.
  const FIRST = NOW + 12 * DAY;
  const moved = (over: Record<string, unknown> = {}) => fresh({ status: "trialing", start_date: NOW - DAY, trial_end: FIRST, metadata: { store: "harbor", product: tierA, moved: "yes" }, ...over });
  member = moved();
  is("its page offers no switch of tier before its first charge", choicesFor(store, (await membershipsFor(store, token))![0], tiers), []);
  const movedPreview = await previewSwitch(store, token, "sub_Member0001", b.product.id);
  is("a switch's preview is refused, never $0 as a free trial, and says when it opens", movedPreview.ok ? [movedPreview.preview.due, movedPreview.preview.trialing] : [movedPreview.reason, waitsUntil(movedPreview)], ["waiting", FIRST]);
  const movedSent = calls.length;
  emails.length = 0;
  const movedMade = await switchTier(store, token, "sub_Member0001", b.product.id, Math.floor(Date.now() / 1000), TEST_CONSENT);
  is("and the switch itself is refused: nothing is charged", movedMade.ok ? movedMade.title : movedMade.reason, "gone");
  is("no price change sent to Stripe, no receipt", [calls.slice(movedSent).filter((c) => c.body.get("items[0][price]")).length, emails.length], [0, 0]);
  is("no move to yearly offered before its first charge", yearlyChoice(yearlySub({ status: "trialing", trial_end: FIRST, metadata: { store: "harbor", product: "club", moved: "yes" } }), club, [], "usd", NOW), null);
  const movedRead = readSub(moved() as never, handles)!;
  is("the numbers read it as paying, with no free trial", [movedRead.status, movedRead.trialEnd], ["active", 0]);
  const movedNumbers = numbersFrom([movedRead], "usd", NOW);
  is("one paying ($10 a month), none in a free trial", [movedNumbers.paying, movedNumbers.trialing, movedNumbers.mrr], [1, 0, 1000]);
  is("after its first charge it never had a free trial", readSub(moved({ status: "active", trial_end: FIRST - 30 * DAY }) as never, handles)!.trialEnd, 0);
  is("the person's page: paying, not 'In a free trial'", typeof status === "function" ? status(moved()) : "missing", "active");
  member = moved();
  is("free days given to it", (await giveFreeDays(store, MEMBER, "sub_Member0001", 2, FIRST, by)).ok, true);
  const movedDays = calls.filter((c) => c.path === "/subscriptions/sub_Member0001" && c.body.get("trial_end")).at(-1)!.body;
  is("are marked as given on a paid membership, with no earlier trial", [movedDays.get("metadata[free_days_paid]"), movedDays.get("metadata[free_days_trial_was]")], ["1", "0"]);

  part("What the switch page says when changing plans waits for the next payment");
  for (const code of Object.keys(LANGUAGES)) {
    const m = membershipWords(code) as unknown as { switchProblems: Record<string, { title: string; body: string }>; switchWaitsOn?: (date: string) => string };
    const waiting = m.switchProblems.waiting;
    is(`${code}: its own words, not "cannot switch"`, Boolean(waiting?.title && waiting.body && waiting.title !== m.switchProblems.gone.title && !/trial|prueba|essai|Testzeit|prova|proef|teste/i.test(waiting.body)), true);
    is(`${code}: with the date when it is known`, typeof m.switchWaitsOn === "function" && m.switchWaitsOn("@@DATE@@").includes("@@DATE@@"), true);
  }
  done();
}

/** The next payment a refused switch waits for, when it says one. */
function waitsUntil(result: object): unknown {
  return "nextCharge" in result ? (result as { nextCharge: unknown }).nextCharge : null;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
