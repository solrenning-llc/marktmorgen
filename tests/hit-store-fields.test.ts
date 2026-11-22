/**
 * The count route (app/api/store/hit) reads only the store's fields it needs,
 * never the whole record (#1496, option A; coordinator, 21 November 2026).
 *
 * The store's record is read whole from the database by storeForHandle, up to
 * MAX_STORE_BYTES, and every byte read is billed. A count needs a few dozen
 * bytes of it: the store's ids, its plan and window, its links' and products'
 * ids. lib/store.ts storeForHit reads those inside Redis, in one script that
 * decodes the record there and answers only them, so the rest never crosses
 * the wire. Nothing is written and no second copy is kept: the record stays
 * the one source.
 *
 * Against the in-memory Redis; synthetic stores and addresses only.
 */
import { NextRequest } from "next/server";
import { POST as hitRoute } from "@/app/api/store/hit/route";
import { HIT_FIELDS_MAX_BYTES, HIT_FIELD_MAX_BYTES, HIT_TEXT_FIELDS, STORE_FOR_HIT, type Store, claimHandle, ownerKey, storeFolder, storeForHandle, storeForHit } from "@/lib/store";
import { countAffiliateClick, countHit, countVisit, isStorePeople } from "@/lib/visit";
import { productIdFor } from "@/lib/catalog";
import { visitsIn } from "@/lib/traffic";
import { allowanceWindow } from "@/lib/allowance-window";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { withinOneUtcDay } from "./one-utc-day";

const PHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
const EMAIL = "fields@example.com";

let sequence = 0;
async function hit(body: Record<string, string>): Promise<void> {
  sequence += 1;
  await hitRoute(
    new NextRequest("https://marktmorgen.com/api/store/hit", {
      method: "POST",
      headers: { "user-agent": PHONE, "x-forwarded-for": `10.9.${(sequence >> 8) & 255}.${sequence & 255}`, "x-vercel-ip-country": "US" },
      body: JSON.stringify(body),
    }),
  );
}

/**
 * The commands the route sends the database, in order: only those that cross the wire, not the ones the in-memory
 * Redis runs inside a script it models (a GET inside a script reads the record where it is, and only the answer
 * travels).
 */
function recording(): { commands: (string | number)[][]; stop: () => void } {
  const commands: (string | number)[][] = [];
  const run = redis.run.bind(redis);
  let depth = 0;
  redis.run = (c: (string | number)[]) => {
    if (depth === 0) commands.push(c);
    depth += 1;
    try {
      return run(c);
    } finally {
      depth -= 1;
    }
  };
  return { commands, stop: () => void (redis.run = run) };
}

async function main(): Promise<void> {
  const realClock = withinOneUtcDay();
  try {
    await checks();
  } finally {
    realClock();
  }
}

async function checks(): Promise<void> {
  redis.clear();
  await claimHandle(EMAIL, "fields", "Fields", "");
  const recordKey = await ownerKey(EMAIL);
  // The record at its heaviest where a count never looks: a long bio and many words of the products', beside the
  // links' and products' ids a count does need.
  const raw = JSON.parse(String(redis.run(["GET", recordKey]))) as Record<string, unknown>;
  raw.bio = "b".repeat(400_000);
  raw.links = [{ id: "l1", title: "My site", url: "https://example.com/" }];
  redis.run(["SET", recordKey, JSON.stringify(raw)]);
  const store = (await storeForHandle("fields"))!;
  const folder = await storeFolder(EMAIL);
  const month = () => allowanceWindow(store, Date.now())!.id;

  const kinds: [string, Record<string, string>][] = [
    ["a visit", { h: "fields", k: "v", r: "", u: "", m: "", g: "" }],
    ["another page", { h: "fields", k: "p", p: "nothing" }],
    ["a link's click", { h: "fields", k: "l", id: "l1" }],
    ["a funnel's step", { h: "fields", k: "f", f: "x", t: "g", id: "p1" }],
    ["an affiliate's visit", { h: "fields", k: "a", c: "nobody" }],
  ];

  part("No count reads the whole store record");
  for (const [name, body] of kinds) {
    const seen = recording();
    try {
      await hit(body);
    } finally {
      seen.stop();
    }
    const whole = seen.commands.filter((c) => String(c[0]).toUpperCase() === "GET" && c[1] === recordKey).length;
    is(`${name}: the record is never fetched whole`, whole, 0);
  }

  part("The visit is still counted from the fields read in the database");
  const before = await visitsIn(folder, month());
  await hit({ h: "fields", k: "v", r: "", u: "", m: "", g: "" });
  is("one visit more", (await visitsIn(folder, month())) - before, 1);

  // Every field a count reads, at a value of its own, so a field read wrong or left out shows.
  const rich = JSON.parse(String(redis.run(["GET", recordKey]))) as Record<string, unknown>;
  Object.assign(rich, {
    tier: "pro",
    cycle: "year",
    subscriptionId: "sub_Fields123456",
    subscriptionActive: true,
    trialEnds: 1_800_000_000_000,
    planEndedAt: "2026-10-01T00:00:00.000Z",
    period: { start: 1_790_000_000, end: 1_790_000_000 + 30 * 86_400, renews: true, funded: true },
    allowanceAnchor: { subscriptionId: "sub_Fields123456", start: 1_789_000_000_000, end: 1_790_000_000_000 },
    affiliates: { enabled: true, percent: 30, days: 30, rates: { abcdef123: 10 } },
    extra: true,
    links: [
      { id: "nolabel", title: "", url: "https://example.com/a" },
      { id: "head", title: "A heading", url: "", header: true },
      { id: "l1", title: "My site", url: "https://example.com/" },
    ],
    catalog: { ...(rich.catalog as Record<string, unknown>), items: [["prodA", 1, "optA1", "optA2"], ["prodB", 2]] },
  });
  redis.run(["SET", recordKey, JSON.stringify(rich)]);
  const full = (await storeForHandle("fields"))!;
  is("the record's period is one a window is read from", full.period !== null, true);

  part("A count reads the same fields as the whole record has");
  const read = (await storeForHit("fields"))!;
  const fields = [...HIT_TEXT_FIELDS, "extra", "subscriptionActive", "trialEnds", "period", "allowanceAnchor"] as const;
  for (const field of fields) is(`${field} is the record's`, (read.store as Record<string, unknown>)[field], (full as Record<string, unknown>)[field]);
  is("the programme is on, as in the record", read.store.affiliates.enabled, full.affiliates.enabled);

  part("A link or a product is the store's by the same rules as the whole record");
  const ask = async (link: string, product: string) => (await storeForHit("fields", { link, product }))!;
  is("a kept link is the store's", (await ask("l1", "")).linkKnown, full.links.some((l) => l.id === "l1"));
  is("a heading is a kept link too", (await ask("head", "")).linkKnown, full.links.some((l) => l.id === "head"));
  is("a link without a title is not kept, so not the store's", (await ask("nolabel", "")).linkKnown, full.links.some((l) => l.id === "nolabel"));
  is("an unknown link is not", (await ask("other", "")).linkKnown, false);
  is("a product is the store's", (await ask("", "prodB")).productKnown, true);
  is("an option's id is not a product", (await ask("", "optA1")).productKnown, false);
  is("an unknown product is not", (await ask("", "nothing")).productKnown, false);

  part("What the script answers is bounded, whatever the record holds");
  const heavy = { ...rich, name: "n".repeat(60), email: `${"e".repeat(HIT_FIELD_MAX_BYTES)}@x.io` };
  redis.run(["SET", recordKey, JSON.stringify(heavy)]);
  const answer = String(redis.run(["EVAL", STORE_FOR_HIT, "1", recordKey, "l1", "prodA", String(HIT_FIELD_MAX_BYTES)]));
  is("the answer is under HIT_FIELDS_MAX_BYTES", Buffer.byteLength(answer) <= HIT_FIELDS_MAX_BYTES, true);
  is("a text past HIT_FIELD_MAX_BYTES reads as missing", (JSON.parse(answer) as Record<string, unknown>).email, undefined);
  is("so the store cannot be read, and nothing is counted", await storeForHit("fields"), null);
  redis.run(["SET", recordKey, JSON.stringify(rich)]);
  is("the script names every text field it answers", HIT_TEXT_FIELDS.every((field) => STORE_FOR_HIT.includes(`'${field}'`)), true);

  part("A record the whole reader takes, the count takes too (Claude 2's independent review)");
  const recordWith = async (change: Record<string, unknown>) => {
    redis.run(["SET", recordKey, JSON.stringify({ ...rich, ...change })]);
    return { whole: (await storeForHandle("fields"))!, counted: await storeForHit("fields", { product: "legacyP" }) };
  };
  // A name kept to 60 characters can end in half an emoji; JSON.stringify writes that lone surrogate as an escape,
  // which Redis's cjson refuses. The script reads it as U+FFFD first, so the store is still counted.
  const cut = await recordWith({ name: `${"a".repeat(59)}😀`.slice(0, 60), bio: `${"b".repeat(159)}😀`.slice(0, 160) });
  is("a name cut in an emoji: the store is still read", cut.counted !== null, true);
  is("and its name keeps the 59 characters before it", cut.counted?.store.name.slice(0, 59), cut.whole.name.slice(0, 59));
  const escapedSlash = await recordWith({ name: "a\\ud83d" });
  is("a name holding the text \\ud83d (an escaped backslash, not a surrogate) reads as written", escapedSlash.counted?.store.name, escapedSlash.whole.name);
  const unfunded = await recordWith({ period: { ...(rich.period as Record<string, unknown>), funded: false } });
  is("a period funded other than true is no period, as the whole reader says", unfunded.counted?.store.period ?? null, unfunded.whole.period);
  const oddRenews = await recordWith({ period: { ...(rich.period as Record<string, unknown>), renews: "yes" } });
  is("a period whose renews is not a flag is no period either", oddRenews.counted?.store.period ?? null, oddRenews.whole.period);
  const oddAnchor = await recordWith({ allowanceAnchor: "x" });
  is("an anchor that is not an object reads as the whole reader reads it", oddAnchor.counted?.store.allowanceAnchor, oddAnchor.whole.allowanceAnchor);
  const legacy = await recordWith({ catalog: undefined, products: [{ id: "legacyP", title: "An old product", priceCents: 500 }] });
  is("a record from before catalogs: its product is known, as productIdFor names it", legacy.counted?.productKnown, productIdFor(legacy.whole, "legacyP") === "legacyP");
  is("and productIdFor does name it", productIdFor(legacy.whole, "legacyP"), "legacyP");
  const untitled = await recordWith({ catalog: undefined, products: [{ id: "legacyP", title: "", priceCents: 500 }] });
  is("an old product the whole reader drops (no title) is not known either", untitled.counted?.productKnown, productIdFor(untitled.whole, "legacyP") === "legacyP");
  redis.run(["SET", recordKey, JSON.stringify(rich)]);

  part("The bound holds at the longest escapes");
  const control = "\u0001".repeat(HIT_FIELD_MAX_BYTES);
  const worst = { ...rich, ...Object.fromEntries(HIT_TEXT_FIELDS.map((field) => [field, control])), allowanceAnchor: { subscriptionId: control, start: 1, end: 2 } };
  redis.run(["SET", recordKey, JSON.stringify(worst)]);
  const longest = String(redis.run(["EVAL", STORE_FOR_HIT, "1", recordKey, "", "", String(HIT_FIELD_MAX_BYTES)]));
  is("every text field at its longest, every byte escaped: under HIT_FIELDS_MAX_BYTES", Buffer.byteLength(longest) <= HIT_FIELDS_MAX_BYTES, true);
  is("and it is near the bound, so the bound is not loose", Buffer.byteLength(longest) > HIT_FIELDS_MAX_BYTES - 1_024, true);
  redis.run(["SET", recordKey, JSON.stringify(rich)]);

  part("What a count does with the store reads only the fields the script answers");
  const allowed = new Set<string>([...fields, "affiliates"]);
  const touched = new Set<string>();
  const watch = <T extends object>(value: T, prefix: string): T =>
    new Proxy(value, {
      get(target, key, receiver) {
        if (typeof key === "string") touched.add(prefix + key);
        const got = Reflect.get(target, key, receiver) as unknown;
        return key === "affiliates" && got && typeof got === "object" ? watch(got as object, "affiliates.") : got;
      },
    });
  const watched = watch(full, "") as Store;
  const request = () =>
    new NextRequest("https://marktmorgen.com/api/store/hit", {
      method: "POST",
      headers: { "user-agent": PHONE, "x-forwarded-for": "10.8.0.1", "x-vercel-ip-country": "US" },
    });
  await countHit(request(), watched, { kind: "view", source: "direct", medium: "", campaign: "" });
  await countVisit(request(), watched);
  await countHit(request(), watched, { kind: "product", id: "prodA" });
  await countHit(request(), watched, { kind: "link", id: "l1" });
  await isStorePeople(request(), watched);
  await countAffiliateClick(request(), watched, "nobody", false);
  await countAffiliateClick(request(), watched, "nobody", true);
  const outside = [...touched].filter((key) => !(allowed.has(key) || key === "affiliates.enabled"));
  is("no field outside the script's answer is read", outside, []);
}

main().then(done, (error) => {
  console.error(error);
  process.exit(1);
});
