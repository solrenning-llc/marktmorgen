/**
 * Choosing who to book with (520 [LB1], unit 6; lib/team-scheduling-rules.ts
 * hostChoices and chosenTeam, lib/calls.ts, the booking page and the studio's
 * team editor; added 2 November 2026). Checked, against the real code with an
 * in-memory Redis and a stand-in for Stripe:
 *
 *   - the rule: a host's public name is a plain short name, never an address
 *     or a link; letting buyers choose is round robin only, with every host
 *     named, each name once;
 *   - the choices: "Any available" is no choice; a position whose name still
 *     matches narrows the team to that host; anything else is "changed";
 *   - a store: the page offers only the chosen host's times; a booking with
 *     a chosen host holds that host and never another, even when another is
 *     free; one that is taken says so; one whose host's name changed since
 *     the page was drawn is refused as "host-changed"; "Any available" is
 *     round robin as before;
 *   - the booking route, the page and the editor carry the choice (read in
 *     their source), and every language says it.
 */
import { readFileSync } from "node:fs";
import { addProduct, claimHandle, ensureStatsId, setProductCall, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import type { Product, Store } from "@/lib/store";
import { readListing, readProduct } from "@/lib/catalog";
import { type CallListing, holdAndCheckout, slotsForProduct } from "@/lib/calls";
import { type CallSetup, zonedToUtc } from "@/lib/call-setup";
import { putMember } from "@/lib/team";
import { type TeamHost, chosenTeam, hostChoices, isHostLabel, readTeamSetup } from "@/lib/team-scheduling-rules";
import { hostId, readClaims } from "@/lib/host-claims";
import { writeTeam } from "@/lib/team-booking";
import { bookingWords } from "@/lib/buyer-words/booking";
import { LANGUAGE_CODES } from "@/lib/store-language";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

const checkouts: URLSearchParams[] = [];
let sessions = 0;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const method = init?.method ?? "GET";
  const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  if (url.hostname === "api.resend.com") return answer({ id: "e" });
  const path = url.pathname.replace(/^\/v1/, "");
  if (method === "POST" && path === "/checkout/sessions") {
    sessions += 1;
    checkouts.push(new URLSearchParams(String(init?.body ?? "")));
    const id = `cs_test_pick${String(sessions).padStart(12, "0")}`;
    return answer({ id, url: `https://checkout.stripe.com/c/pay/${id}` });
  }
  if (method === "POST" && /^\/checkout\/sessions\/[^/]+\/expire$/.test(path)) return answer({ status: "expired" });
  return answer({ object: "list", data: [], has_more: false });
}) as typeof fetch;

const NY = "America/New_York";
const WEEKDAYS: [number, number][][] = [[], [[540, 1020]], [[540, 1020]], [[540, 1020]], [[540, 1020]], [[540, 1020]], []];
const MORNINGS: [number, number][][] = [[], [[540, 720]], [[540, 720]], [[540, 720]], [[540, 720]], [[540, 720]], []];
const weekly = { kind: "weekly", minutes: 60, tz: NY, weekly: WEEKDAYS, noticeHours: 1, horizonDays: 30, bufferMinutes: 0, room: "https://example.com/room", video: false, meet: null, seats: 1, sessions: [] } as unknown as CallSetup;
const host = (email: string, patch: Partial<TeamHost> = {}): TeamHost => ({ email, tz: NY, weekly: WEEKDAYS, bufferMinutes: 0, noticeHours: 1, dailyCap: 4, ...patch });

function weekdayAt(days: number, minute: number): number {
  for (let d = days; d < days + 8; d += 1) {
    const day = new Date(Date.now() + d * 86_400_000);
    const p = new Intl.DateTimeFormat("en-US", { timeZone: NY, year: "numeric", month: "2-digit", day: "2-digit", weekday: "short" }).formatToParts(day);
    const get = (t: string) => p.find((x) => x.type === t)?.value ?? "";
    if (get("weekday") === "Sat" || get("weekday") === "Sun") continue;
    return zonedToUtc(Number(get("year")), Number(get("month")), Number(get("day")), minute, NY) as number;
  }
  throw new Error("no weekday");
}

async function main(): Promise<void> {
  redis.clear();
  process.env.STRIPE_SECRET_KEY = "sk_test_team_pick_only";
  process.env.RESEND_API_KEY = "re_test_team_pick_only";

  part("The rule");
  const raw = (patch: Record<string, unknown> = {}, hosts: Record<string, unknown>[] = [{ ...host("ana@example.com"), label: "Ana" }, { ...host("bia@example.com"), label: "Bia" }]) => ({ mode: "round_robin", hosts, pick: true, ...patch });
  const kept = readTeamSetup(raw(), weekly);
  is("a team that lets buyers choose keeps it, with each name", typeof kept === "string" ? kept : [kept.pick, kept.hosts.map((h) => h.label)], [true, ["Ana", "Bia"]]);
  is("a name's spaces are tidied", (readTeamSetup(raw({}, [{ ...host("ana@example.com"), label: "  Ana   Lima " }]), weekly) as { hosts: TeamHost[] }).hosts[0].label, "Ana Lima");
  is(
    "a name that is an address, a link, markup, too long or not text is refused",
    ["ana@example.com", "https://ana.example", "www.ana", "ana.com", "<b>Ana</b>", "x".repeat(41), "Ana\u0007Lima", "ana.dev", "ana\uff20gmail", ("+" + "55 85 99999-9999"), "ana at gmail dot com", "Ana\u200b", "\u202eanA"].map((label) => readTeamSetup(raw({}, [{ ...host("ana@example.com"), label }]), weekly)).concat([readTeamSetup(raw({}, [{ ...host("ana@example.com"), label: 7 }]), weekly)]),
    Array(14).fill("team_host_label"),
  );
  is(
    "choosing needs round robin, every host named, each name once",
    [readTeamSetup(raw({ mode: "collective" }), weekly), readTeamSetup(raw({}, [{ ...host("ana@example.com"), label: "Ana" }, host("bia@example.com")]), weekly), readTeamSetup(raw({}, [{ ...host("ana@example.com"), label: "Ana" }, { ...host("bia@example.com"), label: "ana" }]), weekly)],
    ["team_pick", "team_pick", "team_pick"],
  );
  const plain = readTeamSetup({ mode: "round_robin", hosts: [host("ana@example.com")] }, weekly);
  is("a team without it reads as before, with no pick and no name", typeof plain === "string" ? plain : ["pick" in plain, "label" in plain.hosts[0]], [false, false]);
  is("a plain name is a name", [isHostLabel("Ana"), isHostLabel("Dr. Ana Lima"), isHostLabel("José"), isHostLabel("Ana (Room 2)")], [true, true, true, true]);

  part("The choices");
  const team = kept as Exclude<typeof kept, string>;
  is("each host's position and name, in the team's order", hostChoices(team), [{ key: "0", label: "Ana" }, { key: "1", label: "Bia" }]);
  is("none on a team that does not let buyers choose", hostChoices({ ...team, pick: undefined }), []);
  is("\"Any available\" is no choice", chosenTeam(team, "", ""), null);
  is("a position whose name still matches narrows the team to that host", chosenTeam(team, "1", "Bia"), { ...team, hosts: [team.hosts[1]] });
  is(
    "another name there, a position past the end, or a team that no longer lets buyers choose: changed",
    [chosenTeam(team, "1", "Ana"), chosenTeam(team, "4", "Bia"), chosenTeam(team, "x", "Bia"), chosenTeam({ ...team, pick: undefined }, "1", "Bia")],
    ["changed", "changed", "changed", "changed"],
  );

  part("A store");
  const OWNER = "owner@example.com";
  const ANA = "ana@example.com";
  await claimHandle(OWNER, "salon", "Bela Salon", "");
  await ensureStatsId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestSalon00001", true);
  await setSubscription(OWNER, { customerId: "cus_salon00001", subscriptionId: "sub_salon00001", active: true, tier: "pro", period: paidPeriod() });
  await putMember((await storeForEmail(OWNER)) as Store, ANA, "editor");
  const made = await addProduct(OWNER, "Haircut", "", "45", null);
  if (!made.ok) throw new Error("no product");
  await setProductCall(OWNER, made.product.id, weekly);
  const store = (await storeForEmail(OWNER)) as Store;
  const listing = (await readListing(store, made.product.id)) as CallListing;
  const full = (await readProduct(store, listing.id)) as Product & { call: CallSetup };
  // The owner, "Bela", works all day; Ana, mornings only.
  await writeTeam(store, listing.id, { mode: "round_robin", pick: true, hosts: [host(OWNER, { label: "Bela" }), host(ANA, { label: "Ana", weekly: MORNINGS })], createdAt: "2026-10-01T00:00:00.000Z" });
  const morning = weekdayAt(3, 600);
  const afternoon = weekdayAt(3, 900);
  const offered = async (key: string | null, start: number) => Boolean((await slotsForProduct(store, listing, key === null ? null : { key }))?.days.some((d) => d.starts.includes(start)));
  const read = await slotsForProduct(store, listing, { key: "1" });
  is("the page is told who may be chosen and who was", [read && "hosts" in read ? read.hosts : null, read && "picked" in read ? read.picked : null], [[{ key: "0", label: "Bela" }, { key: "1", label: "Ana" }], { key: "1", label: "Ana" }]);
  is("with Ana chosen, only her times: the morning, not the afternoon; any available, both", [await offered("1", morning), await offered("1", afternoon), await offered(null, morning), await offered(null, afternoon)], [true, false, true, true]);
  const book = (start: number, chosen: { key: string; label: string } | null) => holdAndCheckout({ store, product: full, start, buyerTz: NY, origin: "https://marktmorgen.com", host: chosen });
  const claimsOf = async (email: string) => ((await readClaims([hostId(email)])).get(hostId(email)) ?? []).map((c) => c.start);
  const first = await book(morning, { key: "0", label: "Bela" });
  is("a booking with Bela chosen holds Bela, though Ana comes first in turn and is free", [first.ok, await claimsOf(OWNER), await claimsOf(ANA), checkouts.at(-1)?.get("metadata[hosts]")], [true, [morning], [], hostId(OWNER)]);
  const second = await book(morning, { key: "0", label: "Bela" });
  is("Bela taken at that time: said as taken, never handed to Ana", [second.ok ? "held" : second.reason, await claimsOf(ANA)], ["taken", []]);
  const changed = await book(afternoon, { key: "1", label: "Bia" });
  is("a name changed since the page was drawn: refused, nobody held", [changed.ok ? "held" : changed.reason, (await claimsOf(ANA)).length, (await claimsOf(OWNER)).length], ["host-changed", 0, 1]);
  const any = await book(morning, null);
  is("any available is round robin as before: Ana, the one still free", [any.ok, await claimsOf(ANA)], [true, [morning]]);

  part("The route, the page and the editor");
  const route = readFileSync("app/api/store/book/route.ts", "utf8");
  is("a refusal keeps the chosen host chosen, but not when the team changed", route.includes('${hostKey && status !== "host-changed" ? `&with=${hostKey}` : ""}'), true);
  is("the route reads the position and the name, and passes them on", [route.includes('hostKey = /^[0-5]$/.test(read("host")) ? read("host") : "";'), route.includes('hostLabel = read("host_label").slice(0, 60);'), route.includes("host: hostKey ? { key: hostKey, label: hostLabel } : null,")], [true, true, true]);
  const page = readFileSync("app/[handle]/book/[product]/page.tsx", "utf8");
  is(
    "the page asks with a labeled choice and a button, and sends the chosen host with the time",
    [page.includes('<form method="get" className="mt-6" data-host-pick="">'), page.includes("<label htmlFor={`host-${product.id}`}"), page.includes('<option value="">{b.hostAny}</option>'), page.includes('<button type="submit" className="btn st-btn-ghost">{b.hostShow}</button>'), page.includes("host={pickedHost}")],
    [true, true, true, true, true],
  );
  const picker = readFileSync("components/slot-picker.tsx", "utf8");
  is("the time picker sends it, never when moving a booking", picker.includes('{host && !move ? (') && picker.includes('<input type="hidden" name="host_label" value={host.label} />'), true);
  const editor = readFileSync("components/team-event-editor.tsx", "utf8");
  is(
    "the editor offers it on round robin, with each host's name, sent only when buyers choose",
    [editor.includes("Let buyers choose who they book with"), editor.includes("Name buyers see (for example, Ana)"), editor.includes("const choose = pick && mode === \"round_robin\";")],
    [true, true, true],
  );

  part("In every language");
  is(
    "each asks, offers any available, shows times, names the host and says the team changed",
    LANGUAGE_CODES.map((code) => {
      const b = bookingWords(code);
      return [code, Boolean(b.hostPick && b.hostAny && b.hostShow), b.withHost("Ana").includes("Ana"), Boolean(b.notices["host-changed"]?.title && b.notices["host-changed"]?.body)];
    }),
    LANGUAGE_CODES.map((code) => [code, true, true, true]),
  );

  done();
}

void main();
