/**
 * Every key family says what becomes of it when its store closes (added 18
 * October 2026; lib/data-families.ts, CLOSING), and what it says fits how
 * tests/store-data-registry.ts says the family is bounded. A new family
 * fails here until it says whether it is erased, found through a token,
 * gone by itself, a person's record that lapses, detached, an index or the
 * company's.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CLOSING, COUNTED_FAMILIES, ELSEWHERE_FAMILIES, FOLLOWED_FAMILIES, closingFamilyOf, countedInRoom } from "@/lib/data-families";
import { FOLLOWERS, followable, ownerOfKey } from "@/lib/closed-store-data";
import { PERSON_RECORD_MONTHS } from "@/lib/joined-stores";
import { FAMILIES } from "./store-data-registry";
import { CURRENT_TAX_OBSERVATION_POLICY, TAX_OBSERVATION_KEEP_SECONDS, TAX_OBSERVATION_LIMITS } from "@/lib/checkout-sweep";

const prefixOf = (name: string) => name.slice(0, name.lastIndexOf("@"));
const byPrefix = new Map<string, (typeof FAMILIES)[string][]>();
for (const [name, family] of Object.entries(FAMILIES)) byPrefix.set(prefixOf(name), [...(byPrefix.get(prefixOf(name)) ?? []), family]);
/** What the prepare step and the file removal reach directly, as lib/closed-store-data.ts and lib/plan-closing.ts do. */
const STEPS = new Set(["prepare", "files"]);
/** The store's own records the closing keeps as the company's, and why. */
const KEPT_AS_COMPANY: Record<string, string> = {
  "nl:plan:closing:": "The closing job's record of the store: dates only, kept ERASED_KEPT_DAYS after (lib/plan-closing.ts).",
  "nl:store:handle:": "The store's addresses, held back from anybody else for RELEASE_QUARANTINE_DAYS (lib/store.ts, closeStoreRecord).",
};
/** Families gone by themselves whose time is set in code and not by a part of the registry. */
const TIMED_IN_CODE: Record<string, [string, string]> = {
  "nl:taxobs:v1:": ["lib/checkout-sweep.ts", "TAX_OBSERVATION_KEEP_SECONDS"],
  "nl:call:confirmed:": ["lib/calls.ts", "CONFIRMED_SECONDS"],
  "nl:adsrv:ctx:": ["lib/ad-events.ts", "CTX_SECONDS"],
  "nl:adsrv:sent:": ["lib/ad-events.ts", "SENT_SECONDS"],
};
/** A person's records across stores that hold a store's id among others and run out by the quarter (lib/joined-stores.ts), and the file that writes them. */
const PERSON_RECORDS: Record<string, string> = {
  "nl:lib:": "lib/buyer-library.ts",
  "nl:lib:joined:": "lib/joined-stores.ts",
  "nl:affhub:": "lib/affiliate-hub.ts",
};
/** The store's records kept in one list for every store, from which the walk takes the store's members. */
const STORE_LISTS: Record<string, string> = {
  "nl:mail:flowq": "One sorted set of every store's steps due, each counted in its own store's room (lib/flows.ts).",
  "nl:payreq:due": "One sorted set of every store's payment request reminders due, each counted in its own store's room (lib/payment-request-store.ts).",
};

test("inactive diagnostic observations retain their existing absolute one-day expiry", () => {
  assert.equal(CURRENT_TAX_OBSERVATION_POLICY, null);
  assert.equal(TAX_OBSERVATION_KEEP_SECONDS, 86_400);
  assert.equal(TAX_OBSERVATION_LIMITS.maxLifetimeMs, TAX_OBSERVATION_KEEP_SECONDS * 1000);
  assert.deepEqual(CLOSING["nl:taxobs:v1:"], { how: "expires", days: 1 });
  assert.equal(countedInRoom("nl:taxobs:v1:synthetic:synthetic"), true);
});

test("every family of the registry says what becomes of it when its store closes, and nothing more is said", () => {
  const registry = new Set(byPrefix.keys());
  const missing = [...registry].filter((p) => !Object.hasOwn(CLOSING, p)).sort();
  assert.deepEqual(missing, [], "say in lib/data-families.ts CLOSING what becomes of each of these when its store closes");
  const stale = Object.keys(CLOSING).filter((p) => !registry.has(p)).sort();
  assert.deepEqual(stale, [], "remove what no family is any more");
  assert.deepEqual([...new Set([...COUNTED_FAMILIES, ...ELSEWHERE_FAMILIES])].sort(), [...registry].sort());
});

test("what each says fits how the registry bounds it", () => {
  for (const [prefix, rule] of Object.entries(CLOSING)) {
    const families = byPrefix.get(prefix) ?? [];
    const company = families.every((f) => f.company);
    const parts = families.flatMap((f) => f.parts ?? []);
    const longest = Math.max(0, ...parts.map((p) => ("per" in p ? p.days : 0)));
    if (rule.how === "lapses") {
      assert.ok(Object.hasOwn(PERSON_RECORDS, prefix), `${prefix}: only a person's record across stores lapses: say so in PERSON_RECORDS`);
      assert.ok(rule.days >= PERSON_RECORD_MONTHS * 31, `${prefix}: kept up to ${PERSON_RECORD_MONTHS} months, said gone within ${rule.days} days`);
      assert.match(readFileSync(join(process.cwd(), PERSON_RECORDS[prefix]), "utf8"), /personWrite\(/, `${prefix}: ${PERSON_RECORDS[prefix]} writes it some other way than by the quarter`);
    } else if (company) {
      assert.ok(["company", "index", "detach"].includes(rule.how), `${prefix}: the company's, so it is kept, an index or detached, not ${rule.how}`);
    } else if (rule.how === "company") {
      assert.ok(Object.hasOwn(KEPT_AS_COMPANY, prefix), `${prefix}: the store's, kept by the company: say why in KEPT_AS_COMPANY`);
    } else if (rule.how === "index") {
      assert.ok(Object.hasOwn(STORE_LISTS, prefix), `${prefix}: the store's, kept in a list of every store's: say so in STORE_LISTS`);
    } else {
      assert.ok(["erase", "token", "expires", "detach"].includes(rule.how), `${prefix}: the store's, so it goes, not ${rule.how}`);
    }
    if (rule.how === "expires") {
      assert.ok(rule.days >= longest, `${prefix}: kept ${longest} days by the registry, said gone within ${rule.days}`);
      const forGood = families.some((f) => f.room?.length) || parts.some((p) => "kept" in p || "item" in p || "capped" in p);
      if (forGood) {
        const timed = TIMED_IN_CODE[prefix];
        assert.ok(timed, `${prefix}: kept for good or with the store by the registry, said to expire: name the constant in TIMED_IN_CODE`);
        assert.match(readFileSync(join(process.cwd(), timed[0]), "utf8"), new RegExp(`${timed[1]}\\s*=\\s*\\d`), `${prefix}: ${timed[0]} has no ${timed[1]}`);
      }
    }
    if ((rule.how === "erase" || rule.how === "token" || rule.how === "company") && rule.rest !== undefined) {
      assert.ok(rule.rest >= Math.min(longest, rule.rest), prefix);
      assert.ok(rule.rest > 0 && rule.rest <= 430, `${prefix}: what is left is gone within ${rule.rest} days`);
    }
    if (rule.how === "token" || rule.how === "detach") {
      const via = rule.via;
      if (STEPS.has(via)) continue;
      assert.ok(Object.hasOwn(FOLLOWERS, via), `${prefix}: reached through ${via}, which has no follower in lib/closed-store-data.ts`);
      assert.equal(CLOSING[via]?.how, "erase", `${prefix}: its follower's family ${via} is not erased`);
    }
  }
  for (const family of Object.keys(FOLLOWERS)) assert.equal(CLOSING[family]?.how, "erase", `${family}: a follower runs on keys the walk deletes`);
  assert.deepEqual(Object.keys(FOLLOWERS).sort(), [...FOLLOWED_FAMILIES].sort(), "lib/data-families.ts FOLLOWED_FAMILIES names every follower, so what they read is priced (tests/plan-cost-registry.ts, closure)");
});

test("a key belongs to its longest family, and the walk takes only what names a closing store", () => {
  const owners = { byMark: new Map([["a".repeat(32), "closing@example.com"]]), byHandle: new Map([["closing-shop", "closing@example.com"]]), byRef: new Map([["closing@example.com", "closing@example.com"]]) };
  const mine = `nl:blog:body:${"a".repeat(32)}:p1`;
  const theirs = `nl:blog:body:${"b".repeat(32)}:p1`;
  assert.equal(closingFamilyOf(mine), "nl:blog:body:");
  assert.equal(ownerOfKey(mine, CLOSING["nl:blog:body:"], owners), "closing@example.com");
  assert.equal(ownerOfKey(theirs, CLOSING["nl:blog:body:"], owners), null);
  assert.equal(ownerOfKey(`nl:pause:closing@example.com`, CLOSING["nl:pause:"], owners), "closing@example.com", "a family named by the store's key");
  assert.equal(ownerOfKey(`nl:weekly:to:closing-shop`, CLOSING["nl:weekly:to:"], owners), "closing@example.com", "a family named by the store's address");
  assert.equal(ownerOfKey(`nl:stats:${"b".repeat(32)}:closing-shop`, CLOSING["nl:stats:"], owners), null, "an address in a family named by ids is not a match");
  assert.equal(CLOSING[closingFamilyOf(`nl:free:in:2026-10:${"a".repeat(32)}`)].how, "company", "the company's record of a store is kept even when the store's id names it");
  assert.equal(followable("nl:mail:unsub:" + "c".repeat(40), "nl:store:leads:"), true);
  assert.equal(followable("nl:lib:2026q4:" + "c".repeat(40), "nl:store:leads:"), false, "a person's library across stores is never deleted: it lapses by the quarter");
  assert.equal(followable(`nl:blog:body:${"b".repeat(32)}:p1`, "nl:erase:ix:"), false, "a follower deletes only the token families it is named for");
});
