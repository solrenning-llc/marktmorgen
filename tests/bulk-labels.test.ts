/**
 * 639 [GL7](3), unit 1: a label on or off many contacts at once
 * (lib/bulk-label-rules.ts, lib/bulk-labels.ts,
 * app/api/store/contact-labels/route.ts, components/bulk-labels.tsx),
 * through the real route, session and store. Reviewed before anything is
 * written; applied to each contact as it is; undone exactly for those it
 * changed; never starting an automation, and saying so before confirming.
 */
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextRequest } from "next/server";
import { POST } from "@/app/api/store/contact-labels/route";
import { BulkLabels } from "@/components/bulk-labels";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { BULK_REFUSALS, BULK_WRITE_BATCH, MAX_BULK_ADDRESSES, MAX_BULK_BODY_BYTES, MAX_BULK_TEXT_BYTES, applySummary, cleanLabel, jsonBytes, labelKey, labelsAfter, opposite, removedFrom, same, undoSummary } from "@/lib/bulk-label-rules";
import { applyBulk, readBulk } from "@/lib/bulk-labels";
import type { DataStore } from "@/lib/store-data";
import { StoreFullError } from "@/lib/store-full";
import { leadsKey, parseContact, upsertContact } from "@/lib/contacts";
import { redisPipeline } from "@/lib/redis";
import { enroll, saveFlow } from "@/lib/flows";
import { sameLabel } from "@/lib/flow-rules";
import { claimHandle, ensureListId, ensureStatsId, ensureStoreId, setMailSettings, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";
import { done, is, part } from "./check";

type Reply = { ok?: boolean; error?: string; message?: string; review?: Record<string, number>; changed?: string[]; label?: string; change?: string; already?: number; full?: number; notOnList?: number; removed?: { email: string; label: string; at: number; forms?: number }[]; asked?: number; noRoom?: number; failed?: number; replaced?: { email: string; label: string; at: number; forms?: number; cleaned?: true }[] };

async function main(): Promise<void> {
  part("The rules");
  is("added once, never twice, in any case", [labelsAfter(["VIP"], "vip", "add"), labelsAfter(["a"], "VIP", "add")], ["same", ["a", "VIP"]]);
  is("taken off in any case, or left", [labelsAfter(["Vip", "b"], "VIP", "remove"), labelsAfter(["b"], "VIP", "remove")], [["b"], "same"]);
  is("never past the most labels a contact holds", labelsAfter(Array.from({ length: 10 }, (_, i) => `t${i}`), "VIP", "add"), "skip");
  is("the undo is the opposite change", [opposite("add"), opposite("remove")], ["remove", "add"]);
  is("a removal keeps the label as that contact had it, and where", [removedFrom(["a", "Vip", "b"], "VIP"), removedFrom(["a"], "VIP")], [{ label: "Vip", at: 1 }, null]);
  is("its undo puts that very label back in its place, or at the end", [labelsAfter(["a", "b"], "VIP", "add", { label: "Vip", at: 1 }), labelsAfter(["a"], "VIP", "add", { label: "Vip", at: 5 })], [["a", "Vip", "b"], ["a", "Vip"]]);
  is("never a label other than the one named", labelsAfter(["a"], "VIP", "add", { label: "Other", at: 0 }), ["a", "VIP"]);
  is("an undo that took everything back says so", undoSummary(3, { changed: 2, already: 1, full: 0, notOnList: 0 }, "add"), { allBack: true, short: "Undone. Every contact is as it was.", words: "Undone. Every contact is as it was." });
  is(
    "one that did not says how many, and why",
    [undoSummary(3, { changed: 1, already: 0, full: 1, notOnList: 1 }, "add").words, undoSummary(4, { changed: 1, already: 0, full: 0, notOnList: 2 }, "remove").words],
    [
      "Undone for 1 of 3 contacts. 2 contacts did not go back: 1 contact is no longer on your list; 1 contact has 10 labels now, the most a contact can have, so the label could not go back on.",
      "Undone for 1 of 4 contacts. 3 contacts did not go back: 2 contacts are no longer on your list; 1 contact was being changed somewhere else at the same moment, so it was left as it is.",
    ],
  );
  is("addresses read from what was pasted, each once", readBulk({ change: "add", label: " Workshop  May ", text: "ana@example.com, Ana@Example.com\nben@example.com; not-an-address@" }), { ok: true, ask: { label: "Workshop May", change: "add", emails: ["ana@example.com", "ben@example.com"], skipped: 1 } });
  is("a label too long is refused, not cut", readBulk({ change: "add", label: "x".repeat(41), text: "ana@example.com" }), { ok: false, error: "label" });
  is("no address, no change chosen, too many: refused", [readBulk({ change: "add", label: "a", text: "" }), readBulk({ change: "x", label: "a", text: "a@example.com" }), readBulk({ change: "add", label: "a", emails: Array.from({ length: MAX_BULK_ADDRESSES + 1 }, (_, i) => `p${i}@example.com`) })].map((r) => (r.ok ? "" : r.error)), ["none", "change", "many"]);
  is("every refusal says what to do", Object.values(BULK_REFUSALS).every((words) => /^(Type|Paste|Choose) /.test(words)), true);

  part("Through the studio's route");
  redis.clear();
  const owner = "labels@example.com";
  await claimHandle(owner, "labelshop", "Label Shop", "");
  await ensureStatsId(owner);
  await ensureStoreId(owner);
  await ensureListId(owner);
  await setStripeAccount(owner, "acct_1TestLabels0001", true);
  await setSubscription(owner, { customerId: "cus_labels", subscriptionId: "sub_labels", active: true, tier: "pro", period: paidPeriod() });
  await setMailSettings(owner, { fromName: "Label Shop", address: "1 Main St, Portland, OR 97201" });
  const store = (await storeForEmail(owner))!;
  // An automation that starts when a contact gets this very label: the bulk change must not start it.
  const flow = await saveFlow(store, { name: "Workshop follow-up", trigger: "tagged", tag: "Workshop May", active: true, steps: [{ delayHours: 0, subject: "About the workshop", body: "Thanks for coming." }] }, { activate: true });
  is("an automation waits on the label", flow.ok && flow.flows[0].active, true);
  const list = store.listId!;
  for (const email of ["ana@example.com", "ben@example.com", "cy@example.com"]) await upsertContact(list, email, { agreed: true, explicit: true, source: "free" }, store);
  const [cyRaw] = await redisPipeline([["HGET", leadsKey(list), "cy@example.com"]]);
  await redisPipeline([["HSET", leadsKey(list), "cy@example.com", JSON.stringify({ ...JSON.parse(String(cyRaw)), tags: ["Workshop May"] })]]);
  const tagsOf = async (email: string) => parseContact((await redisPipeline([["HGET", leadsKey(list), email]]))[0])?.tags ?? null;
  const before = JSON.stringify(await redisPipeline([["HGETALL", leadsKey(list)]]));
  const cookie = `${SESSION_COOKIE}=${await openSession(owner)}`;
  const post = async (body: Record<string, unknown>, headers: Record<string, string> = { cookie }) => {
    const response = await POST(new NextRequest("https://marktmorgen.com/api/store/contact-labels", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) }));
    return { status: response.status, body: (await response.json()) as Reply };
  };
  const pasted = "ana@example.com\nben@example.com\ncy@example.com\nnobody@example.com\nnope@";

  const review = await post({ action: "review", label: "Workshop May", change: "add", text: pasted });
  is("the review says what it would do", review.body.review, { changes: 2, already: 1, notOnList: 1, full: 0, skipped: 1, replaced: 0 });
  is("and writes nothing", JSON.stringify(await redisPipeline([["HGETALL", leadsKey(list)]])), before);

  // Every workflow record (lib/flows.ts keeps runs, steps and held sends under nl:wf:): a run started would write one.
  const workflows = async () => (await redis.keys()).filter((key: string) => key.startsWith("nl:wf:")).sort();
  const workflowsBefore = await workflows();
  const applied = await post({ action: "apply", label: "Workshop May", change: "add", text: pasted });
  is("applied: the contacts it changed, by address", [applied.status, applied.body.changed?.sort(), applied.body.already], [200, ["ana@example.com", "ben@example.com"], 1]);
  is("each contact has the label once", [await tagsOf("ana@example.com"), await tagsOf("cy@example.com")], [["Workshop May"], ["Workshop May"]]);
  is("no one is added who was not on the list", await tagsOf("nobody@example.com"), null);
  is("its automation is not started: no run is written", [workflowsBefore, await workflows()], [[], []]);

  const undone = await post({ action: "apply", label: applied.body.label, change: opposite("add"), emails: applied.body.changed });
  is("undone, exactly: those it changed lose it", [undone.status, undone.body.changed?.sort()], [200, ["ana@example.com", "ben@example.com"]]);
  is("and the one that had it before keeps it", await tagsOf("cy@example.com"), ["Workshop May"]);
  is("every contact as it was", [await tagsOf("ana@example.com"), await tagsOf("ben@example.com")], [[], []]);

  await enroll(store, "ben@example.com", { joined: false, tag: "Workshop May" });
  is("(the way that does start it writes a run, so the check above would see one)", (await workflows()).length > 0, true);

  const refused = await post({ action: "apply", label: "", change: "add", text: pasted });
  is("a refusal says what to do", [refused.status, refused.body.error, refused.body.message], [400, "label", BULK_REFUSALS.label]);
  is("an action that is not one", (await post({ action: "send", label: "a", change: "add", text: pasted })).body.error, "unknown");
  const stranger = await post({ action: "apply", label: "Workshop May", change: "add", text: pasted }, {});
  is("no session: refused, and nothing changed", [stranger.status >= 400 && stranger.status < 500, await tagsOf("ana@example.com")], [true, []]);

  part("Undoing a removal, and an undo that cannot take everything back");
  for (const [email, tags] of [["dee@example.com", ["a", "Vip", "b"]], ["eve@example.com", ["VIP"]], ["fay@example.com", ["vip", "c"]], ["gus@example.com", ["Vip"]]] as const) {
    await upsertContact(list, email, { agreed: true, explicit: true, source: "free" }, store);
    const [raw] = await redisPipeline([["HGET", leadsKey(list), email]]);
    await redisPipeline([["HSET", leadsKey(list), email, JSON.stringify({ ...JSON.parse(String(raw)), tags })]]);
  }
  const taken = await post({ action: "apply", label: "VIP", change: "remove", emails: ["dee@example.com", "eve@example.com"] });
  is("a removal answers with what each contact lost, as written there", [taken.body.changed?.sort(), taken.body.removed?.sort((x, y) => x.email.localeCompare(y.email))], [["dee@example.com", "eve@example.com"], [{ email: "dee@example.com", label: "Vip", at: 1 }, { email: "eve@example.com", label: "VIP", at: 0 }]]);
  const putBack = await post({ action: "apply", label: taken.body.label, change: "add", emails: taken.body.changed, restore: taken.body.removed });
  is("its undo puts each one's own label back, in its place", [putBack.body.changed?.length, await tagsOf("dee@example.com"), await tagsOf("eve@example.com")], [2, ["a", "Vip", "b"], ["VIP"]]);
  await post({ action: "apply", label: "VIP", change: "remove", emails: ["dee@example.com"] });
  const forged = await post({ action: "apply", label: "VIP", change: "add", emails: ["dee@example.com"], restore: [{ email: "dee@example.com", label: "Owner", at: 0 }, { email: "zed@example.com", label: "VIP", at: 0 }] });
  is("an undo never puts on another label, nor touches an address not sent", [forged.body.changed, await tagsOf("dee@example.com"), await tagsOf("zed@example.com")], [["dee@example.com"], ["a", "b", "VIP"], null]);

  const off = await post({ action: "apply", label: "VIP", change: "remove", emails: ["eve@example.com", "fay@example.com", "gus@example.com"] });
  is("taken off three contacts", off.body.changed?.length, 3);
  // Meanwhile one reaches the most labels a contact can have and one leaves the list.
  const [fayRaw] = await redisPipeline([["HGET", leadsKey(list), "fay@example.com"]]);
  await redisPipeline([["HSET", leadsKey(list), "fay@example.com", JSON.stringify({ ...JSON.parse(String(fayRaw)), tags: Array.from({ length: 10 }, (_, i) => `t${i}`) })]]);
  await redisPipeline([["HDEL", leadsKey(list), "gus@example.com"]]);
  const partly = await post({ action: "apply", label: off.body.label, change: "add", emails: off.body.changed, restore: off.body.removed });
  is("the undo answers what went back, and why the rest did not", [partly.body.changed, partly.body.full, partly.body.notOnList], [["eve@example.com"], 1, 1]);
  is(
    "and the creator is told so, not that every contact is as it was",
    undoSummary(off.body.changed!.length, { changed: partly.body.changed!.length, already: partly.body.already!, full: partly.body.full!, notOnList: partly.body.notOnList! }, "add").words,
    "Undone for 1 of 3 contacts. 2 contacts did not go back: 1 contact is no longer on your list; 1 contact has 10 labels now, the most a contact can have, so the label could not go back on.",
  );


  part("Edge cases (review of 4 Nov 2026)");
  const contact = (tags: string[]) => JSON.stringify({ agreed: true, agreedAt: "", firstAt: "", lastAt: "", titles: [], ids: [], source: "free", unsub: false, unsubAt: "", t: "", name: "", tags, importedAt: "" });
  const put = (email: string, tags: string[]) => redisPipeline([["HSET", leadsKey(list), email, contact(tags)]]);
  // Calls to the stand-in are watched: the contacts' atomic writes, a hook just before one, and the data room's answers.
  const pipeline = redis.pipeline.bind(redis);
  const casArgs: number[] = [];
  let beforeWrite: (() => Promise<unknown>) | null = null;
  let roomAnswers: number[] | null = null;
  // From the `failFromEval`-th write on, every call to the list fails, as when the database goes away.
  let failFromEval = 0;
  let broken = false;
  let casSeen = 0;
  redis.pipeline = async (commands: (string | number)[][]) => {
    const [first] = commands;
    if (commands.length === 1 && first[0] === "EVAL" && String(first[1]).includes("redis.sha1hex")) {
      casSeen += 1;
      if (failFromEval && !broken && casSeen >= failFromEval) broken = true;
    }
    if (broken && commands.some((command) => command.includes(leadsKey(list)))) throw new Error("injected: the database went away");
    if (commands.length === 1 && first[0] === "EVAL" && String(first[1]).includes("redis.sha1hex")) {
      casArgs.push(first.length - 4);
      if (beforeWrite) {
        const hook = beforeWrite;
        beforeWrite = null;
        await hook();
      }
    }
    if (roomAnswers && commands.length === 1 && first[0] === "EVAL" && String(first[1]).includes("marktmorgen:store-data:v1") && roomAnswers.length) return [[roomAnswers.shift(), 0]];
    return pipeline(commands);
  };

  // 1. Pasted text past the limit is refused, never cut (a cut could turn ann@example.com into ann@example.co).
  await put("ann@example.co", []);
  await put("ann@example.com", []);
  const longText = "x".repeat(MAX_BULK_TEXT_BYTES - 15) + " ann@example.com";
  is("text past the limit is refused, not cut", [jsonBytes(longText) > MAX_BULK_TEXT_BYTES, readBulk({ change: "add", label: "Cut", text: longText })], [true, { ok: false, error: "long" }]);
  const cutTry = await post({ action: "apply", label: "Cut", change: "add", text: longText });
  is("through the route: a sentence tied to the text, and no contact changed", [cutTry.status, cutTry.body.error, cutTry.body.message, await tagsOf("ann@example.co"), await tagsOf("ann@example.com")], [400, "long", BULK_REFUSALS.long, [], []]);
  is("the body the route reads holds the longest text the limit allows", MAX_BULK_BODY_BYTES > jsonBytes({ action: "apply", label: "x".repeat(40), change: "remove", text: "x".repeat(MAX_BULK_TEXT_BYTES - 2) }), true);
  const thousand = Array.from({ length: MAX_BULK_ADDRESSES }, (_, i) => `${String(i).padStart(4, "0")}${"a".repeat(254 - 4 - "@example.com".length)}@example.com`);
  is("1,000 of the longest addresses fit in the text", jsonBytes(thousand.join("\n")) <= MAX_BULK_TEXT_BYTES && thousand.every((email) => email.length === 254), true);

  // 2 and 8. Undoing a removal of 1,000 of the longest addresses of any script, each label of the longest kind.
  // The stand-in (lib/redis-memory.ts, reserved by Codex, #1502) does not model the CAS_HSET script yet, so every
  // write here runs casWrite's fallback (HMGET, then HSET); one atomic EVAL per batch is held by the EVALs sent.
  const wide = Array.from({ length: MAX_BULK_ADDRESSES }, (_, i) => `${String(i).padStart(4, "0")}${"日".repeat(254 - 4 - "@example.com".length)}@example.com`);
  is("1,000 of the longest addresses of any script fit in the text", [wide.every((email) => email.length === 254), jsonBytes(wide.join("\n")) <= MAX_BULK_TEXT_BYTES, readBulk({ change: "add", label: "a", text: wide.join("\n") }).ok], [true, true, true]);
  is("an address JSON would write as \\u (a control character) is skipped, never sent", readBulk({ change: "add", label: "a", text: "a\u0001b@example.com ann@example.com" }), { ok: true, ask: { label: "a", change: "add", emails: ["ann@example.com"], skipped: 1 } });
  const cjkLabel = "日本".repeat(20);
  const emojiLabel = "😀".repeat(20);
  await redisPipeline([["HSET", leadsKey(list), ...wide.flatMap((email) => [email, contact(["a", cjkLabel, emojiLabel])])]]);
  const undoSizes: number[] = [];
  for (const [name, asked] of [["40 characters of 3 bytes", cjkLabel], ["20 emoji", emojiLabel]] as const) {
    casArgs.length = 0;
    const off = await post({ action: "apply", label: asked, change: "remove", text: wide.join("\n") });
    is(`removed from all 1,000 (a label of ${name}), written ${BULK_WRITE_BATCH} at a time`, [off.status, off.body.changed?.length, casArgs.length, casArgs.every((n) => n <= BULK_WRITE_BATCH * 3)], [200, 1000, MAX_BULK_ADDRESSES / BULK_WRITE_BATCH, true]);
    const withForm = new Set(off.body.removed!.map((entry) => entry.email));
    const undoBody = { action: "apply", label: off.body.label, change: "add", emails: off.body.changed!.filter((email) => !withForm.has(email)), restore: off.body.removed };
    undoSizes.push(jsonBytes(undoBody));
    is(`its undo sends each contact once, with what it lost, and fits (${jsonBytes(undoBody).toLocaleString("en-US")} bytes)`, [undoBody.emails.length, jsonBytes(undoBody) <= MAX_BULK_BODY_BYTES], [0, true]);
    const back = await post(undoBody);
    is(`and every one gets its own label back (${name})`, [back.status, back.body.changed?.length, back.body.asked], [200, 1000, 1000]);
  }
  is("each label back as it was written, in its place", [await tagsOf(wide[0]), await tagsOf(wide[999])], [["a", cjkLabel, emojiLabel], ["a", cjkLabel, emojiLabel]]);
  is("(the first undo is larger than the 450,000 bytes the route used to read)", undoSizes[0] > 450_000, true);
  // The worst any undo can be: 1,000 entries of the longest address and label, every character 3 bytes.
  const worstUndo = { action: "apply", label: "日".repeat(40), change: "add", emails: [], restore: Array.from({ length: MAX_BULK_ADDRESSES }, () => ({ email: "日".repeat(254), label: "日".repeat(40), at: 9, forms: 10, cleaned: true })) };
  const worstAddUndo = { action: "apply", label: "日".repeat(40), change: "remove", emails: Array.from({ length: MAX_BULK_ADDRESSES }, () => "日".repeat(254)), restore: [] };
  is(
    "the route's cap is worked out from the limits: the worst undo and the longest text fit, and no more than that",
    [jsonBytes(worstUndo) <= MAX_BULK_BODY_BYTES, jsonBytes(worstAddUndo) <= MAX_BULK_BODY_BYTES, MAX_BULK_BODY_BYTES - jsonBytes(worstUndo) < 1_000, readFileSync("app/api/store/contact-labels/route.ts", "utf8").includes('guardStoreWrite(request, "send", MAX_BULK_BODY_BYTES)')],
    [true, true, true, true],
  );

  // 3. A contact deleted between the read and the write is said to be no longer on the list.
  await put("m1@example.com", []);
  await put("m2@example.com", []);
  beforeWrite = () => redisPipeline([["HDEL", leadsKey(list), "m2@example.com"]]);
  const raced = await post({ action: "apply", label: "Race", change: "add", emails: ["m1@example.com", "m2@example.com"] });
  is("deleted between the read and the write: not on the list, not changed somewhere else", [raced.body.changed, raced.body.notOnList, raced.body.asked], [["m1@example.com"], 1, 2]);
  is("and said so", applySummary(raced.body.asked!, { changed: 1, already: raced.body.already!, full: raced.body.full!, notOnList: raced.body.notOnList! }, "add").words, "Done: 1 contact changed. 1 was left out: 1 address is not on your list.");
  await put("m2@example.com", ["Race"]);
  beforeWrite = () => redisPipeline([["HDEL", leadsKey(list), "m2@example.com"]]);
  const racedUndo = await post({ action: "apply", label: "Race", change: "remove", emails: ["m1@example.com", "m2@example.com"] });
  is("the same in an undo", undoSummary(2, { changed: racedUndo.body.changed!.length, already: racedUndo.body.already!, full: racedUndo.body.full!, notOnList: racedUndo.body.notOnList! }, "remove").words, "Undone for 1 of 2 contacts. 1 contact did not go back: 1 contact is no longer on your list.");

  // 4. Labels that show nothing, and look-alikes, are one label, and the rest of the studio finds them.
  const labelOf = (typed: string) => {
    const read = readBulk({ change: "add", label: typed, text: "ana@example.com" });
    return read.ok ? read.ask.label : read.error;
  };
  is("a label of nothing that shows is refused", ["\u200B", "\u202E", "\u2060\u200B", "\u2066\u2069", "\u3164", " \u00AD ", "\u180E", "\u2800"].map(labelOf), Array(8).fill("label"));
  is("what shows nothing is taken out; letters are composed; fullwidth Latin is made plain", ["VIP\u200B", "\u2066VIP\u2069", "V\u2060IP", "Cafe\u0301", "ＶＩＰ", "VIP\u{E0041}"].map(labelOf), ["VIP", "VIP", "VIP", "Café", "VIP", "VIP"]);
  const england = "\u{1F3F4}\u{E0067}\u{E0062}\u{E0065}\u{E006E}\u{E0067}\u{E007F}";
  const scotland = "\u{1F3F4}\u{E0067}\u{E0062}\u{E0073}\u{E0063}\u{E0074}\u{E007F}";
  is("joiners and flag tags that make one emoji or one word are kept", ["👨\u200D👩\u200D👧", "می\u200Cخواهم", "അവന\u0D4D\u200D", england, scotland].map(labelOf), ["👨\u200D👩\u200D👧", "می\u200Cخواهم", "അവന\u0D4D\u200D", england, scotland]);
  is("England and Scotland stay two flags, not one black flag", [same(england, scotland), same(england, "\u{1F3F4}"), labelKey(england) === labelKey(england)], [false, false, true]);
  is("format characters that show or shape text are kept, and compatibility ideographs as typed", ["\u0600١٢", "ᠨ\u180Eᠠ", "\uF900"].map(labelOf), ["\u0600١٢", "ᠨ\u180Eᠠ", "\uF900"]);
  is("compared whatever the case, width, composition or hidden characters", [same("VIP", "ＶＩＰ"), same("VIP", "vip\u200B"), same("\u2066VIP\u2069", "Vip"), same("Cafe\u0301", "CAFÉ"), same("ｶﾌｪ", "カフェ"), same("VIP", "VIPS"), labelKey("\u200B")], [true, true, true, true, true, false, ""]);
  is("only width is folded: superscripts, circled and Roman numerals, subscripts stay apart", [same("x²", "x2"), same("①", "1"), same("Ⅳ", "IV"), same("H₂O", "H2O")], [false, false, false, false]);
  await put("look@example.com", ["VIP"]);
  const lookAlikes = await post({ action: "apply", label: "ＶＩＰ", change: "add", text: "look@example.com" });
  const hidden = await post({ action: "apply", label: "VIP\u200B", change: "add", text: "look@example.com" });
  is("a look-alike is not added beside the label", [lookAlikes.body.already, hidden.body.already, await tagsOf("look@example.com")], [1, 1, ["VIP"]]);
  // A contact that holds the label only in a look-alike form (an import wrote it): sending and automations compare by case only.
  await put("kana@example.com", ["ｶﾌｪ", "x"]);
  await put("hide@example.com", ["b", "VIP\u200B"]);
  const kanaReview = await post({ action: "review", label: "カフェ", change: "add", text: "kana@example.com" });
  is("the review says the look-alike will be written as the label", [kanaReview.body.review?.changes, kanaReview.body.review?.replaced, readFileSync("components/bulk-labels.tsx", "utf8").includes("it will be written as")], [1, 1, true]);
  const kana = await post({ action: "apply", label: "カフェ", change: "add", text: "kana@example.com" });
  is("adding replaces the look-alike with the label, where it stood, and answers what it replaced", [await tagsOf("kana@example.com"), kana.body.replaced, (await tagsOf("kana@example.com"))!.some((tag) => sameLabel(tag, "カフェ"))], [["カフェ", "x"], [{ email: "kana@example.com", label: "ｶﾌｪ", at: 0 }], true]);
  is("and says so", applySummary(1, { changed: 1, already: 0, full: 0, notOnList: 0, replaced: 1 }, "add", "カフェ").words, "Done: 1 contact changed. 1 contact had this label written another way, now written as “カフェ” so sending and automations find it.");
  const kanaBack = await post({ action: "apply", label: kana.body.label, change: "remove", emails: [], restore: kana.body.replaced });
  is("its undo puts the look-alike back exactly", [kanaBack.body.changed, await tagsOf("kana@example.com")], [["kana@example.com"], ["ｶﾌｪ", "x"]]);
  const hide = await post({ action: "apply", label: "VIP", change: "add", text: "hide@example.com" });
  is("a form with a hidden character is replaced too, and found by the send filter's comparison", [await tagsOf("hide@example.com"), hide.body.replaced, (await tagsOf("hide@example.com"))!.some((tag) => sameLabel(tag, "VIP"))], [["b", "VIP"], [{ email: "hide@example.com", label: "VIP", at: 1, cleaned: true }], true]);
  await put("forms@example.com", ["VIP", "b", "VIP\u200B", "ＶＩＰ"]);
  const allForms = await post({ action: "apply", label: "vip", change: "remove", text: "forms@example.com" });
  is("taking it off takes every form of it, and says how many it held", [await tagsOf("forms@example.com"), allForms.body.removed], [["b"], [{ email: "forms@example.com", label: "VIP", at: 0, forms: 3 }]]);
  const formsBack = await post({ action: "apply", label: allForms.body.label, change: "add", emails: [], restore: allForms.body.removed });
  is("its undo puts the first form back, where it stood", [formsBack.body.changed, await tagsOf("forms@example.com")], [["forms@example.com"], ["VIP", "b"]]);
  is(
    "and says so, not that every contact is as it was",
    undoSummary(1, { changed: 1, already: 0, full: 0, notOnList: 0 }, "add", { merged: 1 }),
    { allBack: false, short: "Undone. Every contact has the label back as it was shown.", words: "Undone. Every contact has the label back as it was shown. 1 contact had this label in more than one form. It got the label back once, in the first form." },
  );
  await post({ action: "apply", label: "VIP", change: "remove", text: "forms@example.com" });
  await post({ action: "apply", label: "VIP", change: "add", emails: [], restore: [{ email: "forms@example.com", label: "VIP\u200B\u202E", at: 0 }] });
  is("what an undo sends back is cleaned before it is written", await tagsOf("forms@example.com"), ["VIP", "b"]);
  await put("ctl@example.com", ["a", "\u0001".repeat(39) + "V"]);
  const ctl = await post({ action: "apply", label: "V", change: "remove", text: "ctl@example.com" });
  is("a form with control characters is answered cleaned, and marked so", ctl.body.removed, [{ email: "ctl@example.com", label: "V", at: 1, cleaned: true }]);
  const ctlBack = await post({ action: "apply", label: "V", change: "add", emails: [], restore: ctl.body.removed });
  is("its undo puts back the form as it was shown, and says so", [await tagsOf("ctl@example.com"), undoSummary(1, { changed: ctlBack.body.changed!.length, already: 0, full: 0, notOnList: 0 }, "add", { cleaned: 1 }).words], [["a", "V"], "Undone. Every contact has the label back as it was shown. 1 contact got the label back as it looks, without the hidden differences it had."]);

  // 5. The 40 the screen says is counted after spaces are collapsed and what shows nothing is taken out, as the screen counts.
  is("counted after collapsing spaces", [labelOf("a  " + "b".repeat(38)), labelOf("x".repeat(40) + "\u200B"), labelOf("x".repeat(41))], ["a " + "b".repeat(38), "x".repeat(40), "label"]);
  is("some emoji count as 2 or more, as the screen says", [labelOf("😀".repeat(20)), labelOf("😀".repeat(21)), labelOf("👍\u{1F3FD}".repeat(10)), labelOf("👍\u{1F3FD}".repeat(11)), BULK_REFUSALS.label.includes("Some emoji count as 2 or more."), readFileSync("components/bulk-labels.tsx", "utf8").includes("some emoji count as 2 or more")], ["😀".repeat(20), "label", "👍\u{1F3FD}".repeat(10), "label", true, true]);
  is("the screen shows how much of the 40 is used, counted the same way", readFileSync("components/bulk-labels.tsx", "utf8").includes("Used: ${cleanLabel(label).length} of ${MAX_TAG_LENGTH}."), true);
  is("the field no longer cuts what is pasted into it", /id="bulk-label"[^\n]*maxLength/.test(readFileSync("components/bulk-labels.tsx", "utf8")), false);
  is("the screen shows the label as it will be written", [cleanLabel("  Workshop \u200B May "), readFileSync("components/bulk-labels.tsx", "utf8").includes("the label “${cleanLabel(label)}”")], ["Workshop May", true]);

  // 7. After applying, the screen says how many were left out and why.
  is(
    "what applying did, with every reason",
    [
      applySummary(5, { changed: 5, already: 0, full: 0, notOnList: 0 }, "add"),
      applySummary(9, { changed: 3, already: 2, full: 1, notOnList: 1, noRoom: 1 }, "add").words,
      applySummary(4, { changed: 1, already: 2, full: 0, notOnList: 0 }, "remove").words,
      applySummary(9, { changed: 3, already: 2, full: 1, notOnList: 1, noRoom: 1 }, "add").short,
    ],
    [
      { short: "Done: 5 contacts changed.", words: "Done: 5 contacts changed." },
      "Done: 3 contacts changed. 6 were left out: 2 contacts already have the label; 1 contact has 10 labels already, the most a contact can have; 1 address is not on your list; 1 contact was not changed because your store has no room left for more records; 1 contact was being changed somewhere else at the same moment, so it was left as it is.",
      "Done: 1 contact changed. 3 were left out: 2 contacts don't have it; 1 contact was being changed somewhere else at the same moment, so it was left as it is.",
      "Done: 3 contacts changed. 6 were left out.",
    ],
  );
  is("the screen shows it, and says only the short sentence", ["<span id=\"bulk-done-line\">{done.words}</span>", "setLive(summary.short);", "words: summary.words"].map((piece) => readFileSync("components/bulk-labels.tsx", "utf8").includes(piece)), [true, true, true]);

  // H1. Something going wrong after some batches were written: those are answered, the rest counted, the undo kept.
  const failEmails = Array.from({ length: MAX_BULK_ADDRESSES }, (_, i) => `fail${i}@example.com`);
  await redisPipeline([["HSET", leadsKey(list), ...failEmails.flatMap((email) => [email, contact([])])]]);
  casSeen = 0;
  failFromEval = 3;
  const broke = await post({ action: "apply", label: "Broke", change: "add", text: failEmails.join("\n") });
  failFromEval = 0;
  broken = false;
  is("an error on the third write answers the two batches written, with the rest counted as failed", [broke.status, broke.body.changed?.length, broke.body.failed, broke.body.asked, await tagsOf(failEmails[0]), await tagsOf(failEmails[999])], [200, 2 * BULK_WRITE_BATCH, MAX_BULK_ADDRESSES - 2 * BULK_WRITE_BATCH, MAX_BULK_ADDRESSES, ["Broke"], []]);
  is(
    "and says so honestly",
    applySummary(broke.body.asked!, { changed: broke.body.changed!.length, already: broke.body.already!, full: broke.body.full!, notOnList: broke.body.notOnList!, failed: broke.body.failed }, "add").words,
    "Done: 400 contacts changed. 600 were left out: something went wrong with 600 contacts, so they may not have changed; review again to see.",
  );
  const brokeBack = await post({ action: "apply", label: "Broke", change: "remove", emails: broke.body.changed, restore: [] });
  is("its undo takes back what was written", [brokeBack.body.changed?.length, await tagsOf(failEmails[0])], [2 * BULK_WRITE_BATCH, []]);
  casSeen = 0;
  failFromEval = 1;
  const brokeAll = await post({ action: "apply", label: "Broke", change: "add", text: failEmails.join("\n") });
  failFromEval = 0;
  broken = false;
  is("an error before anything was written is refused, as before", [brokeAll.status, brokeAll.body.error, await tagsOf(failEmails[0])], [500, "server_error", []]);

  // 8. A data room that fills part way: what was written is answered, so it can be undone.
  const batchEmails = Array.from({ length: BULK_WRITE_BATCH + 50 }, (_, i) => `room${i}@example.com`);
  await redisPipeline([["HSET", leadsKey(list), ...batchEmails.flatMap((email) => [email, contact([])])]]);
  // Long enough that every contact grows by more than a step of the data room. The room is the store's own
  // fields without its page order: lib/contacts.ts needContacts reads a room with an `order` as an order's.
  const roomLabel = "Room for the spring workshop, every seat";
  const roomFields: Record<string, unknown> = { ...store };
  delete roomFields.order;
  const roomOnly = roomFields as DataStore;
  const roomAsk = (emails: string[]) => ({ label: roomLabel, change: "add" as const, emails, skipped: 0 });
  roomAnswers = [1, 0];
  const partway = await applyBulk(list, roomAsk(batchEmails), roomOnly);
  is("the first batch is written and answered; the rest is counted as not written", [partway.changed.length, partway.noRoom, partway.asked, await tagsOf(batchEmails[0]), await tagsOf(batchEmails[BULK_WRITE_BATCH])], [BULK_WRITE_BATCH, 50, BULK_WRITE_BATCH + 50, [roomLabel], []]);
  roomAnswers = [0];
  const none = await applyBulk(list, roomAsk(batchEmails.slice(BULK_WRITE_BATCH)), roomOnly).then(() => "written", (error: unknown) => (error instanceof StoreFullError ? "full" : String(error)));
  is("one that can write nothing is refused as a full store, as before", none, "full");
  roomAnswers = null;
  redis.pipeline = pipeline;

  part("The screen");
  const html = renderToStaticMarkup(createElement(BulkLabels));
  is("every field labeled, with an example read with it", html.includes('<label for="bulk-text"') && html.includes("Their email addresses") && html.includes('aria-describedby="bulk-text-hint"') && html.includes('<label for="bulk-label"') && html.includes('aria-describedby="bulk-label-hint"'), true);
  is("what to do, as a group of choices", html.includes("<fieldset") && html.includes("<legend") && html.includes("Add the label") && html.includes("Take the label off"), true);
  is("says before confirming that no automation starts", html.includes("Adding a label here doesn&#x27;t start its automations."), true);
  is("a review first, its result in a status, refusals in an alert", html.includes("Review the change") && html.includes('role="status"') && html.includes('role="alert"'), true);
  const screen = readFileSync("components/bulk-labels.tsx", "utf8");

  part("The screen: accessibility (AAA audit, 4 Nov 2026)");
  is("no control is disabled while busy, so focus stays on it (2.4.3)", [/\sdisabled=\{/.test(screen), screen.includes("aria-disabled={busy || undefined}"), screen.includes("aria-disabled={busy || review.changes === 0 || undefined}")], [false, true, true]);
  is("a press while busy, or with nothing to change, does nothing", [screen.includes("if (busy) return;"), screen.includes("if (busy || !review || review.changes === 0 || tooLong()) return;"), screen.includes("if (busy || !done) return;")], [true, true, true]);
  is("the live region holds one short sentence, not the review", [html.includes('<p role="status" class="sr-only"></p>'), /role="status"[^>]*>\s*\{review/.test(screen), screen.includes("{live}")], [true, false, true]);
  is("the review's title takes focus when it arrives", screen.includes('id="bulk-review-title" ref={reviewTitle} tabIndex={-1}') && screen.includes('focusNext.current = "review";'), true);
  is("after Apply, focus goes to Undo (or the done line); after Undo, to the form's title", [screen.includes('focusNext.current = changed.length ? "undo" : "done";'), screen.includes("ref={undoButton}"), screen.includes("ref={doneLine} tabIndex={-1}"), screen.includes('focusNext.current = "title";'), html.includes('id="bulk-title" tabindex="-1"')], [true, true, true, true, true]);
  is("focus is moved by refs, after the screen changed", screen.includes("useEffect(() => {") && screen.includes(".current?.focus();"), true);
  is("Undo says what it undoes", screen.includes('aria-describedby="bulk-done-line"'), true);
  is("a refusal is tied to its field: text, label or the choice (3.3.1)", ['none: "text"', 'many: "text"', 'label: "label"', 'change: "change"', 'aria-invalid={errorField === "text" || undefined}', 'aria-invalid={errorField === "label" || undefined}', '`bulk-${field}-error`'].every((piece) => screen.includes(piece)), true);
  is("shown next to the field, the end of the form keeps only the others", [html.includes('id="bulk-text-error" class="field-error mt-1 block" role="alert"'), html.includes('id="bulk-label-error"'), html.includes('id="bulk-change-error"'), screen.includes('{errorField ? "" : error}')], [true, true, true, true]);
  is("a refusal goes once its field is changed (3.3.1)", [screen.includes("const edit = <T,>(set: (value: T) => void, field: Field) => (value: T) => {"), screen.includes("if (errorField === field) {"), ['edit(setText, "text")', 'edit(setLabel, "label")', 'edit(setChange, "change")'].every((piece) => screen.includes(piece))], [true, true, true]);
  is("the live line gets only a short sentence after applying and undoing; every reason stays on the screen", [(screen.match(/setLive\(summary\.short\)/g) ?? []).length, screen.includes("setLive(summary.words)"), screen.includes("setNote(summary.words);")], [2, false, true]);
  is("nothing is said twice: no toast beside the live line (4.1.3)", [screen.includes("toast("), screen.includes("@/components/toast")], [false, false]);
  is("a full store is said in plain words (3.1.5)", [screen.includes("data room"), screen.includes("Your store has no room left for more records. Delete some you no longer need first.")], [false, true]);
  is("the review lists how many, and that nothing is sent", screen.includes("will ${change === \"add\" ? \"get\" : \"lose\"} the label") && screen.includes("No automation starts and no email is sent. You can undo this right after."), true);
  is("anything typed after a review asks for a new one", screen.includes("setReview(null);"), true);
  is("the undo sends back exactly what changed, with each label as it was", screen.includes("change: undoing, emails: done.changed.filter((email) => !withForm.has(email)), restore: done.taken") && screen.includes("const withForm = new Set(done.taken.map((entry) => entry.email));") && screen.includes("const undoing = opposite(done.change);"), true);
  is("and says what the route answered, kept on the screen", screen.includes("undoSummary(done.changed.length,") && screen.includes("setNote(summary.words);") && !screen.includes('toast("Undone. Every contact is as it was.")'), true);
  is("the server code never reaches the browser", !screen.includes('from "@/lib/bulk-labels"') && !readFileSync("lib/bulk-label-rules.ts", "utf8").includes('from "@/lib/contacts"'), true);
  is("nothing here starts a workflow", !readFileSync("lib/bulk-labels.ts", "utf8").includes('from "@/lib/flows"') && !readFileSync("app/api/store/contact-labels/route.ts", "utf8").includes("enroll"), true);
  is("reached from the contacts import, for those who may use it", readFileSync("app/studio/import/page.tsx", "utf8").includes('kind === "contacts" && can(access.role, "send")') && readFileSync("app/studio/labels/page.tsx", "utf8").includes('"send");'), true);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
