/**
 * Audit R43, finding 2: the come-back offer (lib/winback-send.ts) goes "Never to somebody who has already come back"
 * (lib/winback.ts). A store checkout makes a new Stripe customer each time, so one address can hold several customers
 * on the creator's account: whether the person is back is read across every customer of that address, not only the
 * one whose membership ended. A list read in part or in another shape, or a provider error, means nothing is sent this
 * run (CX-123 rule 24) and the run's own mark is let go, so a whole reading on a later run decides. Stripe's list
 * filter matches the address as written, so the customers are also found by Stripe's customer search and compared in
 * small letters. Synthetic Stripe and email sender only; the search stand-in matches addresses in any letters, which
 * real Stripe was not checked for.
 */
import { addProduct, claimHandle, ensureListId, ensureStatsId, setProductLink, setStripeAccount, setSubscription, setWinBack, storeForEmail } from "@/lib/store";
import { upsertContact } from "@/lib/contacts";
import { sendWinBacks } from "@/lib/winback-send";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";
import { ROOM } from "./data-room";

const DAY = 86_400;
const now = Date.now();
const nowS = Math.floor(now / 1000);
const OWNER = "r43-winback@example.com";
const HANDLE = "rfortythree";
const emails: { to: string[] }[] = [];
const events: Record<string, unknown>[] = [];
let product = "";

/** Each customer's own email as Stripe holds it. */
const customerEmail = new Map<string, string>();
/** What /customers?email= answers, per exact email: a body, or a status for a provider error. */
const listBody = new Map<string, unknown>();
/** What /customers/search answers, per address searched in small letters: a body, or a status for a provider error. */
const searchBody = new Map<string, unknown>();
/** What /subscriptions?customer= answers, per customer. */
const subsBody = new Map<string, unknown>();
const subsReads = new Map<string, number>();

const list = (data: unknown[], hasMore = false) => ({ object: "list", data, has_more: hasMore });
const live = (id: string) => list([{ id, status: "active", metadata: { store: HANDLE, product } }]);
const gone = (id: string) => list([{ id, status: "canceled", metadata: { store: HANDLE, product } }]);

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  if (url.hostname === "api.resend.com") {
    emails.push(JSON.parse(String(init?.body)) as { to: string[] });
    return new Response(JSON.stringify({ id: "email_1" }));
  }
  const path = url.pathname.replace(/^\/v1/, "");
  const answer = (body: unknown) => new Response(JSON.stringify(body));
  if (path === "/events") return answer(list(events));
  const one = path.match(/^\/customers\/(cus_\w+)$/);
  if (one) return answer({ id: one[1], email: customerEmail.get(one[1]) ?? null });
  if (path === "/customers") {
    const email = url.searchParams.get("email") ?? "";
    const body = listBody.has(email)
      ? listBody.get(email)
      : list([...customerEmail].filter(([, e]) => e === email).map(([id, e]) => ({ id, object: "customer", email: e })));
    if (body === 500) return new Response(JSON.stringify({ error: { message: "synthetic provider error" } }), { status: 500 });
    return answer(body);
  }
  if (path === "/customers/search") {
    const email = (url.searchParams.get("query")?.match(/^email:"([^"]*)"$/)?.[1] ?? "").toLowerCase();
    const body = searchBody.has(email)
      ? searchBody.get(email)
      : { object: "search_result", data: [...customerEmail].filter(([, e]) => e.toLowerCase() === email).map(([id, e]) => ({ id, object: "customer", email: e })), has_more: false, next_page: null };
    if (body === 500) return new Response(JSON.stringify({ error: { message: "synthetic provider error" } }), { status: 500 });
    return answer(body);
  }
  if (path === "/subscriptions") {
    const customer = url.searchParams.get("customer") ?? "";
    subsReads.set(customer, (subsReads.get(customer) ?? 0) + 1);
    return answer(subsBody.get(customer) ?? list([]));
  }
  return new Response(JSON.stringify({ error: { message: `no stand-in for ${path}` } }), { status: 404 });
}) as typeof fetch;

function ended(sub: string, customer: string): void {
  events.push({
    id: `evt_${sub}`,
    type: "customer.subscription.deleted",
    created: nowS - 8 * DAY,
    data: { object: { id: sub, customer, ended_at: nowS - 8 * DAY, metadata: { store: HANDLE, product }, items: { data: [{ price: { recurring: { interval: "month", interval_count: 1 } } }] } } },
  });
}

/** A person whose membership ended 8 days ago under `old` (email as Stripe holds it), on the creator's list. */
async function person(listId: string, name: string, old: string, email = `${name}@example.com`): Promise<void> {
  customerEmail.set(old, email);
  subsBody.set(old, gone(`sub_${name}Ended0001`));
  ended(`sub_${name}Ended0001`, old);
  await upsertContact(listId, email.toLowerCase(), { agreed: true, explicit: true, source: "buyer" }, ROOM);
}

const sentTo = () => emails.map((e) => [e.to].flat()[0]);
const run = async () => {
  emails.length = 0;
  await sendWinBacks(Date.now() + 30_000, now);
  return sentTo().sort();
};

async function main(): Promise<void> {
  process.env.STRIPE_SECRET_KEY = "sk_test_r43_winback_only_a_stand_in";
  process.env.RESEND_API_KEY = "re_test_a_stand_in_key_for_tests_only";
  redis.clear();
  const made = await claimHandle(OWNER, HANDLE, "Harbor Kitchen", "");
  if (!made.ok) throw new Error("no store");
  await ensureStatsId(OWNER);
  await ensureListId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestRfortyThr", true);
  await setSubscription(OWNER, { customerId: "cus_RfortyOwner1", subscriptionId: "sub_RfortyOwner1", active: true, tier: "pro", period: paidPeriod() });
  const club = await addProduct(OWNER, "The Inner Circle", "", "29", { interval: "month", trialDays: 0, payments: 0 });
  if (!club.ok) throw new Error("no product");
  product = club.product.id;
  await setProductLink(OWNER, product, "https://example.com/club");
  await setWinBack(OWNER, { percent: 25, months: 2, days: 7, coupon: "co_Back0001", address: "1 Main St, Portland, OR 97201" });
  const store = (await storeForEmail(OWNER))!;
  const listId = store.listId as string;

  part("Two customers under one address: the one whose membership ended, and a newer one");
  // Ivy did not come back: her address holds only the old customer. Control.
  await person(listId, "ivy", "cus_IvyOld000001");
  // Hal joined again from the store page: a second customer, with a live membership of the same product.
  await person(listId, "hal", "cus_HalOld000001");
  customerEmail.set("cus_HalNew000001", "hal@example.com");
  subsBody.set("cus_HalNew000001", live("sub_HalLive00001"));
  // Joy has a second customer too, with no live membership: still not back. Control.
  await person(listId, "joy", "cus_JoyOld000001");
  customerEmail.set("cus_JoyNew000001", "joy@example.com");
  subsBody.set("cus_JoyNew000001", gone("sub_JoyOther0001"));
  // Quinn's old customer holds the address in capitals; the newer one, live, holds it in small letters.
  await person(listId, "quinn", "cus_QuinnOld0001", "Quinn@Example.com");
  customerEmail.set("cus_QuinnNew0001", "quinn@example.com");
  subsBody.set("cus_QuinnNew0001", live("sub_QuinnLive001"));

  part("Back under the same address written in other letters (Claude 2 and Codex S on #3371)");
  // Sam ended in small letters; his live membership is under the address in mixed letters.
  await person(listId, "sam", "cus_SamOld000001");
  customerEmail.set("cus_SamNew000001", "Sam@Example.com");
  subsBody.set("cus_SamNew000001", live("sub_SamLive00001"));
  // Tess ended in mixed letters and is back in other mixed letters: neither as written nor in small letters.
  await person(listId, "tess", "cus_TessOld00001", "Tess@Example.com");
  customerEmail.set("cus_TessNew00001", "TESS@example.com");
  subsBody.set("cus_TessNew00001", live("sub_TessLive0001"));
  // Wren has a second customer in other letters with nothing live: still not back. Control.
  await person(listId, "wren", "cus_WrenOld00001");
  customerEmail.set("cus_WrenNew00001", "WREN@Example.com");
  subsBody.set("cus_WrenNew00001", gone("sub_WrenOther001"));

  part("A list of the address's customers read in part, in another shape, or not at all: nothing is sent");
  await person(listId, "kim", "cus_KimOld000001");
  listBody.set("kim@example.com", { object: "list" });
  await person(listId, "lee", "cus_LeeOld000001");
  listBody.set("lee@example.com", list([{ id: "cus_LeeOld000001", object: "customer" }], true));
  await person(listId, "mia", "cus_MiaOld000001");
  listBody.set("mia@example.com", list([{ id: "cus_MiaOld000001", object: "customer" }, { object: "customer", email: "mia@example.com" }]));
  await person(listId, "ned", "cus_NedOld000001");
  listBody.set("ned@example.com", 500);
  // Ola's newer customer is listed, but its memberships come back in another shape.
  await person(listId, "ola", "cus_OlaOld000001");
  customerEmail.set("cus_OlaNew000001", "ola@example.com");
  subsBody.set("cus_OlaNew000001", { object: "list", data: "none" });
  // Pia: a whole, empty list of customers (the old customer, read on its own, is still read). Control.
  await person(listId, "pia", "cus_PiaOld000001");
  listBody.set("pia@example.com", list([]));
  // Rex: more customers under the address than one offer reads memberships for.
  await person(listId, "rex", "cus_RexOld000001");
  for (let i = 0; i < 12; i += 1) customerEmail.set(`cus_RexMore0000${i.toString().padStart(2, "0")}`, "rex@example.com");
  // The customer search answers with a provider error, more than one page, a row without its address, or another shape.
  await person(listId, "xan", "cus_XanOld000001");
  searchBody.set("xan@example.com", 500);
  await person(listId, "yul", "cus_YulOld000001");
  searchBody.set("yul@example.com", { object: "search_result", data: [{ id: "cus_YulOld000001", object: "customer", email: "yul@example.com" }], has_more: true, next_page: "page_2" });
  await person(listId, "zed", "cus_ZedOld000001");
  searchBody.set("zed@example.com", { object: "search_result", data: [{ id: "cus_ZedOther0001", object: "customer" }], has_more: false, next_page: null });
  await person(listId, "abe", "cus_AbeOld000001");
  searchBody.set("abe@example.com", { object: "search_result", data: "none", has_more: false });

  const first = await run();
  is("control: Ivy, who has not come back, gets the offer", first.includes("ivy@example.com"), true);
  is("control: Joy, whose other customer has nothing live, gets the offer", first.includes("joy@example.com"), true);
  is("control: Pia, with a whole and empty list of other customers, gets the offer", first.includes("pia@example.com"), true);
  is("control: Wren, whose other customer in other letters has nothing live, gets the offer", first.includes("wren@example.com"), true);
  is("Hal, back as a newer customer of the same address, gets no come-back email", first.includes("hal@example.com"), false);
  is("Quinn, back under the same address in small letters, gets no come-back email", first.includes("quinn@example.com"), false);
  is("Sam, back under the same address in mixed letters, gets no come-back email", first.includes("sam@example.com"), false);
  is("Tess, back under the same address in other mixed letters, gets no come-back email", first.includes("tess@example.com"), false);
  for (const name of ["kim", "lee", "mia", "ned", "ola", "xan", "yul", "zed", "abe"]) is(`${name}: an unknown reading of the address's customers sends nothing`, first.includes(`${name}@example.com`), false);
  is("Rex: past the memberships read for one offer, nothing is sent", first.includes("rex@example.com"), false);
  const rexReads = [...subsReads].filter(([id]) => id.startsWith("cus_Rex")).reduce((n, [, c]) => n + c, 0);
  is("Rex: the membership reads for one offer stay bounded (at most 10 pages)", rexReads <= 10, true);
  is("the run wrote to exactly the four who have not come back", first, ["ivy@example.com", "joy@example.com", "pia@example.com", "wren@example.com"]);

  part("Whole readings on the next run: the marks let go on unknown readings decide again, once");
  for (const name of ["kim", "lee", "mia", "ned"]) listBody.delete(`${name}@example.com`);
  for (const name of ["xan", "yul", "zed", "abe"]) searchBody.delete(`${name}@example.com`);
  subsBody.set("cus_OlaNew000001", gone("sub_OlaOther0001"));
  const second = await run();
  is("the nine read in full now get the offer, and nobody gets a second one", second, [
    "abe@example.com",
    "kim@example.com",
    "lee@example.com",
    "mia@example.com",
    "ned@example.com",
    "ola@example.com",
    "xan@example.com",
    "yul@example.com",
    "zed@example.com",
  ]);
  is("Sam and Tess, still back, get no come-back email on a later run either", second.some((to) => to === "sam@example.com" || to === "tess@example.com"), false);
  const third = await run();
  is("a third run sends nothing more", third, []);
  done();
}

void main();
