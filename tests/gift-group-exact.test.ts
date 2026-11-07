/**
 * Gifts and purchases for several, read exactly (CX-123 rules 24 and 30), synthetic only: the in-memory Redis double
 * and an email stand-in; no Stripe, no real email. The defects come from the sweep A3 proofs
 * (tests/sweep-a3-gift-group-start.proof.test.ts, tests/sweep-a3-group-place.proof.test.ts on claude5/sweep-a3),
 * here with the expectations turned the right way round, beside healthy controls:
 *
 * 1. startGift / startGroup: a write of the record answered in an unknown shape is refused before the checkout opens
 *    ("unavailable": the page says nothing was charged), never ok with no record behind a paid checkout.
 * 2. deliverGift / settleGroup: the record read in an unknown shape, or a write after handing over (the payment's
 *    mapping a refund looks up, the record marked given or paid) answered in an unknown shape, throws, so no "sent"
 *    mark is kept and the next run does it again, and the mapping a refund needs is there once it says done.
 * 3. takePlace: an unknown answer from the places counter hands nothing out, and that address can try again.
 * 4. askPlace: an unknown answer from the day's email count, or from the places read, sends nothing.
 */
import { addProduct, claimHandle, ensureStatsId, setProductLink, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { readListing } from "@/lib/catalog";
import { deliverGift, readGift, startGift } from "@/lib/gifts";
import { askPlace, placesTaken, readGroup, settleGroup, startGroup, takePlace } from "@/lib/group-buy";
import { importedFor } from "@/lib/imported-purchases";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

type Command = (string | number)[];
const real = redis.pipeline.bind(redis);
const UNKNOWN = { unexpected: true };
/**
 * Every pipeline runs as usual, except that a command `match` picks is answered in an unknown shape: run (the write
 * lands) when `lands`, otherwise not run at all.
 */
function unknownFor(match: (c: Command) => boolean, lands: boolean): void {
  redis.pipeline = (async (commands: Command[]) => {
    const picked = commands.map(match);
    const ran = await real(commands.filter((_, i) => lands || !picked[i]));
    let k = 0;
    return commands.map((_, i) => {
      const reply = lands || !picked[i] ? ran[k++] : undefined;
      return picked[i] ? UNKNOWN : reply;
    });
  }) as typeof redis.pipeline;
}
const restore = () => {
  redis.pipeline = real;
};
const isSet = (prefix: string, also: (c: Command) => boolean = () => true) => (c: Command) => c[0] === "SET" && String(c[1]).startsWith(prefix) && also(c);
/** What a call came to: its answer, or "threw" when it refused by throwing. */
const outcome = <T>(p: Promise<T>): Promise<T | "threw"> => p.then((v) => v, () => "threw" as const);

const emails: { to: string[] }[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  if (new URL(String(input)).hostname === "api.resend.com") {
    emails.push(JSON.parse(String(init?.body)) as { to: string[] });
    return new Response(JSON.stringify({ id: "email_1" }), { status: 200 });
  }
  return new Response(JSON.stringify({ error: { message: "no stand-in" } }), { status: 404 });
}) as typeof fetch;

async function main(): Promise<void> {
  redis.clear();
  process.env.STRIPE_SECRET_KEY = "sk_test_gift_group_exact_only";
  process.env.RESEND_API_KEY = "re_test_groups_only";
  const OWNER = "giftgroupexact@example.com";
  await claimHandle(OWNER, "giftexact", "Gift Exact", "");
  await ensureStatsId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestGiftEx01", true);
  await setSubscription(OWNER, { customerId: "cus_GiftExact0001", subscriptionId: "sub_GiftExact0001", active: true, period: paidPeriod() });
  const made = await addProduct(OWNER, "Glaze Guide", "", "49", null);
  if (!made.ok) throw new Error("no product");
  await setProductLink(OWNER, made.product.id, "https://example.com/guide");
  let store = (await storeForEmail(OWNER))!;
  const product = (await readListing(store, made.product.id))!;
  let n = 0;
  const paidSession = (meta: Record<string, string>) => {
    n += 1;
    return {
      id: "cs_test_" + String(n).padStart(24, "g"),
      created: Math.floor(Date.now() / 1000),
      amount_total: 4900,
      currency: "usd",
      payment_intent: `pi_GiftExact${String(n).padStart(6, "0")}`,
      metadata: { store: "giftexact", product: product.id, ...meta },
      customer_details: { email: "payer@example.com" },
    };
  };
  const base = "https://marktmorgen.com/@giftexact";
  const from = '"Gift Exact" <hello@marktmorgen.com>';
  const deps = { store, product, base, from };
  const giftDeps = { ...deps, recordStart: async () => {}, ordersLink: async () => null };
  const get = async (key: string) => (await real([["GET", key]]))[0];

  part("1. startGift: healthy control");
  const okGift = await startGift(store, product, { to: "friend@example.com", from: "Ana", message: "" });
  if (!okGift.ok) throw new Error("no gift");
  const okGiftSession = paidSession({ gift: okGift.gift.id });
  is("written down, then handed over once paid", [Boolean(await readGift(okGift.gift.id)), await deliverGift({ ...giftDeps, session: okGiftSession })], [true, "given"]);
  is("the payment's mapping a refund looks up is kept", await get(`nl:gift:pi:${okGiftSession.payment_intent}`), okGift.gift.id);

  part("1. startGift: the SET of the record answered in an unknown shape (not landed) is refused before any checkout");
  unknownFor(isSet("nl:gift:gft_"), false);
  const lost = await outcome(startGift(store, product, { to: "friend2@example.com", from: "Ana", message: "" }));
  restore();
  is("refused as unavailable (the page says nothing was charged), never ok", lost, { ok: false, reason: "unavailable" });

  part("1. startGift: the same SET landed but answered in an unknown shape is refused as well");
  unknownFor(isSet("nl:gift:gft_"), true);
  const landed = await outcome(startGift(store, product, { to: "friend3@example.com", from: "Ana", message: "" }));
  restore();
  is("refused as unavailable", landed, { ok: false, reason: "unavailable" });

  part("1. startGroup: healthy control");
  const okGroup = await startGroup(store, product, "3");
  if (!okGroup.ok) throw new Error("no group");
  const okGroupSession = paidSession({ group: okGroup.group.id, people: "3" });
  is("written down, then settled once paid", [Boolean(await readGroup(okGroup.group.id)), await settleGroup({ ...deps, session: okGroupSession })], [true, "settled"]);
  is("the payment's mapping a refund looks up is kept", await get(`nl:grp:pi:${okGroupSession.payment_intent}`), okGroup.group.id);

  part("1. startGroup: the SET of the record answered in an unknown shape is refused before any checkout");
  unknownFor(isSet("nl:grp:grp_"), false);
  const lostGroup = await outcome(startGroup(store, product, "3"));
  restore();
  is("refused as unavailable, never ok", lostGroup, { ok: false, reason: "unavailable" });

  part("2. deliverGift: the gift's record read in an unknown shape is not 'skip'");
  const g2 = await startGift(store, product, { to: "friend4@example.com", from: "Ana", message: "" });
  if (!g2.ok) throw new Error("no gift");
  const g2Session = paidSession({ gift: g2.gift.id });
  unknownFor((c) => c[0] === "GET" && c[1] === `nl:gift:${g2.gift.id}`, true);
  const g2Read = await outcome(deliverGift({ ...giftDeps, session: g2Session }));
  restore();
  is("throws, so no 'sent' mark is kept and the next run hands it over", g2Read, "threw");
  is("the next run hands it over", await deliverGift({ ...giftDeps, session: g2Session }), "given");

  part("2. deliverGift: the payment's mapping answered in an unknown shape (landed)");
  const g3 = await startGift(store, product, { to: "friend5@example.com", from: "Ana", message: "" });
  if (!g3.ok) throw new Error("no gift");
  const g3Session = paidSession({ gift: g3.gift.id });
  unknownFor(isSet("nl:gift:pi:"), true);
  const g3First = await outcome(deliverGift({ ...giftDeps, session: g3Session }));
  restore();
  is("throws instead of saying given", g3First, "threw");
  is("the gift is not marked given yet, so the next run is not 'already'", (await readGift(g3.gift.id))?.given ?? null, null);
  is("the next run hands it over (the giving mark was let go)", await deliverGift({ ...giftDeps, session: g3Session }), "given");
  is("and the mapping a refund looks up is there", await get(`nl:gift:pi:${g3Session.payment_intent}`), g3.gift.id);

  part("2. deliverGift: the record marked given answered in an unknown shape (not landed)");
  const g4 = await startGift(store, product, { to: "friend6@example.com", from: "Ana", message: "" });
  if (!g4.ok) throw new Error("no gift");
  const g4Session = paidSession({ gift: g4.gift.id });
  unknownFor(isSet(`nl:gift:${g4.gift.id}`, (c) => !String(c[1]).endsWith(":giving")), false);
  const g4First = await outcome(deliverGift({ ...giftDeps, session: g4Session }));
  restore();
  is("throws instead of saying given", g4First, "threw");
  is("the next run hands it over and marks it given", [await deliverGift({ ...giftDeps, session: g4Session }), typeof (await readGift(g4.gift.id))?.given], ["given", "number"]);

  part("2. settleGroup: the record read in an unknown shape is not 'skip'");
  const p2 = await startGroup(store, product, "2");
  if (!p2.ok) throw new Error("no group");
  const p2Session = paidSession({ group: p2.group.id, people: "2" });
  unknownFor((c) => c[0] === "GET" && c[1] === `nl:grp:${p2.group.id}`, true);
  const p2Read = await outcome(settleGroup({ ...deps, session: p2Session }));
  restore();
  is("throws, so no 'sent' mark is kept", p2Read, "threw");
  is("the next run settles it", await settleGroup({ ...deps, session: p2Session }), "settled");

  part("2. settleGroup: the payment's mapping answered in an unknown shape (landed)");
  const p3 = await startGroup(store, product, "2");
  if (!p3.ok) throw new Error("no group");
  const p3Session = paidSession({ group: p3.group.id, people: "2" });
  unknownFor(isSet("nl:grp:pi:"), true);
  const p3First = await outcome(settleGroup({ ...deps, session: p3Session }));
  restore();
  is("throws instead of saying settled", p3First, "threw");
  is("the purchase is not marked paid yet, so the next run is not 'already'", (await readGroup(p3.group.id))?.paid ?? null, null);
  is("the next run settles it", await settleGroup({ ...deps, session: p3Session }), "settled");
  is("and the mapping a refund looks up is there", await get(`nl:grp:pi:${p3Session.payment_intent}`), p3.group.id);

  part("2. settleGroup: the record marked paid answered in an unknown shape (not landed)");
  const p4 = await startGroup(store, product, "2");
  if (!p4.ok) throw new Error("no group");
  const p4Session = paidSession({ group: p4.group.id, people: "2" });
  unknownFor(isSet(`nl:grp:${p4.group.id}`, (c) => c[1] === `nl:grp:${p4.group.id}`), false);
  const p4First = await outcome(settleGroup({ ...deps, session: p4Session }));
  restore();
  is("throws instead of saying settled", p4First, "threw");
  is("the next run settles it and marks it paid", [await settleGroup({ ...deps, session: p4Session }), typeof (await readGroup(p4.group.id))?.paid], ["settled", "number"]);

  // A purchase for two, paid, for the places.
  const started = await startGroup(store, product, "2");
  if (!started.ok) throw new Error("no group");
  const id = started.group.id;
  if ((await settleGroup({ ...deps, session: paidSession({ group: id, people: "2" }) })) !== "settled") throw new Error("not settled");
  store = (await storeForEmail(OWNER))!;
  const token = async (email: string) => {
    const t = Buffer.from(email.padEnd(32, "x").slice(0, 32)).toString("hex");
    await real([["SET", `nl:grp:take:${t}`, JSON.stringify({ g: id, e: email }), "EX", 3600]]);
    return t;
  };
  const take = async (email: string) => {
    const taken = await outcome(takePlace({ store, token: await token(email), recordStart: async () => {} }));
    return taken === "threw" ? taken : taken.outcome;
  };
  const owns = async (email: string) => (await importedFor({ ...store, pastBuyers: true }, email)).map((p) => p.productId);

  part("3. takePlace: healthy control (2 places paid for)");
  is("exactly two taken, the third told full", [await take("ana@example.com"), await take("ben@example.com"), await take("cy@example.com"), await placesTaken(id)], ["taken", "taken", "full", 2]);
  is("both places hold the product; nothing for the third", [await owns("ana@example.com"), await owns("ben@example.com"), await owns("cy@example.com")], [[product.id], [product.id], []]);

  part("3. takePlace: the places counter answers in an unknown shape (the count still moves)");
  unknownFor((c) => c[0] === "INCR" && String(c[1]).endsWith(":n"), true);
  const third = await take("dee@example.com");
  restore();
  is("refused (a temporary error), never 'taken' past the two paid for", third === "taken", false);
  is("nothing handed to that address", await owns("dee@example.com"), []);
  is("the same link opened again is told full, never 'already' with nothing given", await take("dee@example.com"), "full");

  part("3. takePlace: a fresh purchase for two, its first place's counter unknown");
  const two = await startGroup(store, product, "2");
  if (!two.ok) throw new Error("no group");
  if ((await settleGroup({ ...deps, session: paidSession({ group: two.group.id, people: "2" }) })) !== "settled") throw new Error("not settled");
  const tokenFor = async (email: string) => {
    const t = Buffer.from(("z" + email).padEnd(32, "x").slice(0, 32)).toString("hex");
    await real([["SET", `nl:grp:take:${t}`, JSON.stringify({ g: two.group.id, e: email }), "EX", 3600]]);
    return t;
  };
  unknownFor((c) => c[0] === "INCR" && String(c[1]).endsWith(":n"), false);
  const firstUnknown = await outcome(takePlace({ store, token: await tokenFor("gus@example.com"), recordStart: async () => {} }));
  restore();
  is("refused, nothing handed over", [firstUnknown === "threw" || (firstUnknown as { outcome: string }).outcome !== "taken", await owns("gus@example.com")], [true, []]);
  const again = await takePlace({ store, token: await tokenFor("gus@example.com"), recordStart: async () => {} });
  is("the same address can take its place on a later try", [again.outcome, await owns("gus@example.com")], ["taken", [product.id]]);

  part("4. askPlace: healthy control, within the day's email cap, a place left");
  const links: string[] = [];
  const watching = (match: ((c: Command) => boolean) | null) => {
    redis.pipeline = (async (commands: Command[]) => {
      for (const c of commands) if (c[0] === "SET" && String(c[1]).startsWith("nl:grp:take:")) links.push(String(c[2]));
      const replies = await real(commands);
      return match ? commands.map((c, i) => (match(c) ? UNKNOWN : replies[i])) : replies;
    }) as typeof redis.pipeline;
  };
  const room = await startGroup(store, product, "2");
  if (!room.ok) throw new Error("no group");
  if ((await settleGroup({ ...deps, session: paidSession({ group: room.group.id, people: "2" }) })) !== "settled") throw new Error("not settled");
  store = (await storeForEmail(OWNER))!;
  const ask = (gid: string, email: string) => askPlace({ store, id: gid, email, product, base, from, ordersLink: async () => null });
  watching(null);
  const sentOk = await ask(room.group.id, "hal@example.com");
  restore();
  is("sent, with a place link written for that address", [sentOk, links.some((l) => l.includes("hal@example.com"))], ["sent", true]);

  part("4. askPlace: healthy control, the day's email cap (2 x 3 + 10 = 16) reached");
  await real([["SET", `nl:grp:${id}:mail`, "16", "EX", 86_400], ["SET", `nl:grp:${id}:n`, "0"]]);
  links.length = 0;
  watching(null);
  const healthy = await ask(id, "eve@example.com");
  restore();
  is("slow: no link written", [healthy, links.length], ["slow", 0]);

  part("4. askPlace: the day's email count answers in an unknown shape (the count still moves)");
  watching((c) => c[0] === "INCR" && String(c[1]).endsWith(":mail"));
  const asked = await outcome(ask(id, "fay@example.com"));
  restore();
  is("nothing sent: no link for fay written, and not 'sent'", [asked === "sent", links.some((l) => l.includes("fay@example.com"))], [false, false]);

  part("4. askPlace: the places read answers in an unknown shape");
  await real([["SET", `nl:grp:${id}:mail`, "0", "EX", 86_400], ["SET", `nl:grp:${id}:n`, "0"]]);
  watching((c) => c[0] === "GET" && String(c[1]).endsWith(":n"));
  const unread = await outcome(ask(id, "gil@example.com"));
  restore();
  is("nothing sent: no link for gil written, and not 'sent'", [unread === "sent", links.some((l) => l.includes("gil@example.com"))], [false, false]);

  part("5. settleGroup: another run holds the settling mark and this run's SET NX answers in an unknown shape (C4-3000)");
  const p5 = await startGroup(store, product, "2");
  if (!p5.ok) throw new Error("no group");
  const p5Session = paidSession({ group: p5.group.id, people: "2" });
  const p5Mark = `nl:grp:${p5.group.id}:settling`;
  await real([["SET", p5Mark, "another-run", "EX", 300]]);
  const p5Emails = emails.length;
  unknownFor(isSet(p5Mark), false);
  const p5First = await outcome(settleGroup({ ...deps, session: p5Session }));
  restore();
  is("not settled a second time beside the other run: it throws, no receipt", [p5First, emails.length - p5Emails], ["threw", 0]);
  is("the other run's mark is left alone", await get(p5Mark), "another-run");
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
