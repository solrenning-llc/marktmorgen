/**
 * lib/free.ts reads Redis only in its exact shape (sweep A2 findings 9 and the two listed after it; CX-123 rule 24/30).
 * Synthetic only: the in-memory Redis stand-in, a reply replaced where a lost or other-shaped one is wanted.
 *
 *   1. spendClaim: an INCR reply that is not a whole number was NaN, and `NaN > MAX_CLAIM_USES` is false, so a link
 *      already used up was answered good again. An unknown count is now refused as unknown (UnknownReplyError), and
 *      the download route says so as a temporary error; a free copy is never handed out on a count nobody read.
 *   2. listSize: any error, or a count in another shape, was a list of 0, and the full export was priced from it
 *      (lib/store-export.ts exportShape). An unknown read now throws.
 *   3. listAsCsv: a field list or answers unreadable or in another shape (Claude 3 on #2862), an HSCAN reply in another
 *      shape or a cursor that never came back to zero gave a CSV missing columns or rows, handed over as complete. Each
 *      now throws, so the list download says it could not read the list and the store export writes that part as unread.
 */
import { createHash } from "node:crypto";
import { NextRequest } from "next/server";
import { MAX_CLAIM_USES, listAsCsv, listSize, spendClaim } from "@/lib/free";
import { agreedKey, leadsKey, unsubKey } from "@/lib/contacts";
import { personKey } from "@/lib/person-key";
import type { Store } from "@/lib/store";
import { storeExport } from "@/lib/store-export";
import { POST as download } from "@/app/api/store/free/download/route";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const claimKeyOf = (token: string) => `nl:free:claim:${sha(`nimbus-free-claim:${token}`).slice(0, 40)}`;
const original = redis.pipeline.bind(redis);
type Commands = (string | number)[][];

/** Replaces the reply to the pipeline whose first command matches, once the real one ran (or instead of it). */
function replyFor(match: (commands: Commands) => boolean, reply: (commands: Commands) => unknown, run = true): void {
  redis.pipeline = (async (commands: Commands) => {
    if (match(commands)) {
      if (run) await original(commands);
      return reply(commands);
    }
    return original(commands);
  }) as typeof redis.pipeline;
}
const restore = () => {
  redis.pipeline = original;
};

/** The error's name when the call throws, "answered" when it does not. */
async function outcome(call: () => Promise<unknown>): Promise<string> {
  try {
    await call();
    return "answered";
  } catch (error) {
    return error instanceof Error ? error.name : "thrown";
  }
}

async function claimFor(token: string) {
  await original([["SET", claimKeyOf(token), JSON.stringify({ h: "nostore", p: "p".repeat(32), e: "lead@example.com", c: false, at: "2026-11-06T00:00:00.000Z" })]]);
}

const LIST = "list-exact-1";
const shop = { handle: "shop", listId: LIST, statsId: null } as unknown as Store;
const shopWithFields = { handle: "shop", listId: LIST, statsId: "stats-exact-1" } as unknown as Store;

async function seedList() {
  const contact = (agreed: boolean, unsub = false) => JSON.stringify({ agreed, agreedAt: agreed ? "2026-11-01" : "", firstAt: "2026-11-01", lastAt: "2026-11-02", titles: ["Guide"], ids: [], source: "free", unsub, unsubAt: unsub ? "2026-11-03" : "" });
  await original([
    ["HSET", leadsKey(LIST), "ann@example.com", contact(true), "bob@example.com", contact(false), "cy@example.com", contact(true, true)],
    ["SET", agreedKey(LIST), "2"],
    ["SET", unsubKey(LIST), "1"],
  ]);
}

async function main() {
  // ---------------------------------------------------------------- 1. spendClaim
  redis.clear();
  part("Healthy control: a link with uses left works, and the one past the cap is spent");
  const good = "a".repeat(64);
  await claimFor(good);
  const first = await spendClaim(good);
  is("the first use of a fresh link is good", first.ok, true);
  for (let i = 1; i < MAX_CLAIM_USES; i += 1) await spendClaim(good);
  const past = await spendClaim(good);
  is(`the ${MAX_CLAIM_USES + 1}th use is refused as spent`, past.ok ? "ok" : past.reason, "spent");
  is("an unknown token is expired", await spendClaim("z".repeat(64)).then((r) => (r.ok ? "ok" : r.reason)), "expired");

  part("A used-up link, the INCR reply lost or in another shape: unknown, never good again");
  const shapes: [string, () => unknown][] = [
    ["no reply", () => []],
    ["QUEUED", () => ["QUEUED", "QUEUED"]],
    ["null", () => [null, 1]],
    ["a numeric string", () => ["11", 1]],
    ["a fraction", () => [10.5, 1]],
    ["one reply for two commands", () => [11]],
  ];
  for (const [label, reply] of shapes) {
    replyFor((c) => c[0]?.[0] === "INCR", reply);
    const got = await outcome(() => spendClaim(good));
    restore();
    is(`${label}: refused as unknown`, got, "UnknownReplyError");
  }

  part("A fresh link, the INCR reply unknown: refused too (no copy handed out on a count nobody read)");
  const fresh = "b".repeat(64);
  await claimFor(fresh);
  replyFor((c) => c[0]?.[0] === "INCR", () => ["QUEUED", "QUEUED"]);
  is("a fresh link with an unknown count is refused as unknown", await outcome(() => spendClaim(fresh)), "UnknownReplyError");
  restore();

  part("The claim itself read in another shape is unknown, not \"expired\"");
  replyFor((c) => c[0]?.[0] === "GET" && String(c[0][1]).startsWith("nl:free:claim:"), () => [], false);
  is("a lost GET reply is unknown", await outcome(() => spendClaim(fresh)), "UnknownReplyError");
  replyFor((c) => c[0]?.[0] === "GET" && String(c[0][1]).startsWith("nl:free:claim:"), () => [42], false);
  is("a number where the claim was is unknown", await outcome(() => spendClaim(fresh)), "UnknownReplyError");
  restore();

  part("The download route says an unknown count is a temporary error, never hands the file over");
  const post = async (token: string) => {
    const form = new FormData();
    form.set("token", token);
    return download(new NextRequest("https://marktmorgen.com/api/store/free/download", { method: "POST", body: form, headers: { origin: "https://marktmorgen.com", host: "marktmorgen.com", "sec-fetch-site": "same-origin" } }));
  };
  replyFor((c) => c[0]?.[0] === "INCR", () => ["QUEUED", "QUEUED"]);
  const unknownAnswer = await post(good).then(async (r) => ({ status: r.status, text: await r.text() }), (e: unknown) => ({ status: 0, text: String(e) }));
  restore();
  is("the route answers 503", unknownAnswer.status, 503);
  is("and says the link could not be checked, not that it is spent or expired", /could not check this link/i.test(unknownAnswer.text), true);
  const spentAnswer = await post(good);
  is("control: the used-up link with a readable count is 429", spentAnswer.status, 429);

  // ---------------------------------------------------------------- 2. listSize
  redis.clear();
  await seedList();
  part("Healthy control: the list's size on a good read");
  is("three addresses, one that may be written to", await listSize(shop), { total: 3, agreed: 1, full: false });
  is("an empty list is read as empty", await listSize({ ...shop, listId: "list-exact-empty" } as Store), { total: 0, agreed: 0, full: false });

  part("An unknown read is not an empty list");
  const sizeShapes: [string, () => unknown][] = [
    ["no reply", () => []],
    ["HLEN as QUEUED", () => ["QUEUED", "2", "1"]],
    ["HLEN as null", () => [null, "2", "1"]],
    ["the agreed count not a number", () => [3, "two", "1"]],
    ["the unsubscribed count as an object", () => [3, "2", { n: 1 }]],
  ];
  for (const [label, reply] of sizeShapes) {
    replyFor((c) => c[0]?.[0] === "HLEN", reply, false);
    is(`${label}: throws`, await outcome(() => listSize(shop)), "UnknownReplyError");
    restore();
  }
  redis.pipeline = (async () => {
    throw new Error("network");
  }) as typeof redis.pipeline;
  is("a failed read throws, not total 0", await outcome(() => listSize(shop)), "Error");
  restore();

  // ---------------------------------------------------------------- 3. listAsCsv
  part("Healthy control: the CSV on a good read");
  const csv = await listAsCsv(shop, false);
  const lines = csv.trimEnd().split("\r\n");
  is("a header and three rows", lines.length, 4);
  is("every address is in it", ["ann@", "bob@", "cy@"].every((a) => csv.includes(a)), true);
  const agreed = (await listAsCsv(shop, true)).trimEnd().split("\r\n");
  is("only the one who may be written to, with onlyAgreed", agreed.length === 2 && agreed[1].includes("ann@example.com"), true);
  is("an empty list is a header only", (await listAsCsv({ ...shop, listId: "list-exact-empty" } as Store, false)).trimEnd().split("\r\n").length, 1);

  part("An HSCAN reply in another shape is not the end of the list");
  const scanShapes: [string, () => unknown][] = [
    ["no reply", () => []],
    ["null", () => [null]],
    ["a cursor alone", () => [["0"]]],
    ["members not a list", () => [["0", "ann@example.com"]]],
    ["an odd member list", () => [["0", ["ann@example.com"]]]],
    ["a cursor that is not a number", () => [["next", []]]],
  ];
  for (const [label, reply] of scanShapes) {
    replyFor((c) => c[0]?.[0] === "HSCAN", reply, false);
    is(`${label}: throws`, await outcome(() => listAsCsv(shop, false)), "UnknownReplyError");
    restore();
  }
  replyFor((c) => c[0]?.[0] === "HSCAN", () => [["7", []]], false);
  is("a cursor that never comes back to zero throws, not a short CSV", await outcome(() => listAsCsv(shop, false)), "UnknownReplyError");
  restore();

  part("The store's own fields unreadable: no CSV missing their columns");
  replyFor((c) => c[0]?.[0] === "GET" && String(c[0][1]).startsWith("nl:crm:fields:"), () => {
    throw new Error("network");
  }, false);
  is("the field list unreadable throws", await outcome(() => listAsCsv(shopWithFields, false)), "Error");
  restore();
  await original([["SET", "nl:crm:fields:stats-exact-1", JSON.stringify([{ id: "f1abcd", name: "Company", type: "text" }])]]);
  replyFor((c) => c[0]?.[0] === "HGETALL", () => {
    throw new Error("network");
  }, false);
  is("their answers unreadable throws", await outcome(() => listAsCsv(shopWithFields, false)), "Error");
  restore();

  // Second review of #2862 (Claude 3, LEVE): only a THROWN read threw; a GET/HGETALL reply lost or in another shape was
  // read as "no fields" / "no answers", and a CSV missing the store's own column (or its values) was handed over.
  part("The store's own fields read in another shape: no CSV missing their column or their values");
  await original([["HSET", "nl:crm:v:stats-exact-1:f1abcd", personKey("stats-exact-1", "ann@example.com"), "Acme"]]);
  const withFields = (await listAsCsv(shopWithFields, false)).trimEnd().split("\r\n");
  is("control: the header ends with the Company column", withFields[0].endsWith(',"Company"'), true);
  is("control: ann's row ends with Acme", withFields.some((row) => row.startsWith('"ann@example.com"') && row.endsWith(',"Acme"')), true);
  await original([["SET", "nl:crm:fields:stats-exact-none", JSON.stringify([])]]);
  is("control: a stored empty field list is a CSV with no field column", (await listAsCsv({ ...shopWithFields, statsId: "stats-exact-none" } as Store, false)).split("\r\n")[0].endsWith('"imported_at"'), true);
  is("control: no field list stored is a CSV with no field column", (await listAsCsv({ ...shopWithFields, statsId: "stats-exact-unset" } as Store, false)).split("\r\n")[0].endsWith('"imported_at"'), true);
  const fieldShapes: [string, () => unknown][] = [
    ["no reply", () => []],
    ["a reply without result (undefined)", () => [undefined]],
    ["QUEUED", () => ["QUEUED"]],
    ["a number", () => [42]],
    ["text that is not JSON", () => ["[{bad"]],
    ["JSON that is not a list", () => [JSON.stringify({ id: "f1abcd" })]],
  ];
  for (const [label, reply] of fieldShapes) {
    replyFor((c) => c[0]?.[0] === "GET" && String(c[0][1]).startsWith("nl:crm:fields:"), reply, false);
    is(`the field list as ${label}: throws`, await outcome(() => listAsCsv(shopWithFields, false)), "UnknownReplyError");
    restore();
  }
  const answerShapes: [string, () => unknown][] = [
    ["no reply", () => []],
    ["a reply without result (undefined)", () => [undefined]],
    ["QUEUED", () => ["QUEUED"]],
    ["null", () => [null]],
    ["an odd-length list", () => [["ann-key"]]],
    ["a list holding a number", () => [["ann-key", 7]]],
  ];
  for (const [label, reply] of answerShapes) {
    replyFor((c) => c[0]?.[0] === "HGETALL", reply, false);
    is(`the answers as ${label}: throws`, await outcome(() => listAsCsv(shopWithFields, false)), "UnknownReplyError");
    restore();
  }

  part("The store export writes the contacts part as unread, never as a complete CSV");
  replyFor((c) => c[0]?.[0] === "HSCAN", () => [null], false);
  let exported = "";
  const reader = storeExport(shop).getReader();
  for (;;) {
    const { value, done: end } = await reader.read();
    if (end) break;
    exported += new TextDecoder().decode(value);
  }
  restore();
  is("no contactsCsv in the export", exported.includes("\"contactsCsv\""), false);
  is("the contacts part (the fifth) is said as unread", exported.includes("\"unreadPart5\""), true);

  done();
}
main();
