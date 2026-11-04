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
import { BULK_REFUSALS, MAX_BULK_ADDRESSES, labelsAfter, opposite, removedFrom, undoSummary } from "@/lib/bulk-label-rules";
import { readBulk } from "@/lib/bulk-labels";
import { leadsKey, parseContact, upsertContact } from "@/lib/contacts";
import { redisPipeline } from "@/lib/redis";
import { enroll, saveFlow } from "@/lib/flows";
import { claimHandle, ensureListId, ensureStatsId, ensureStoreId, setMailSettings, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";
import { done, is, part } from "./check";

type Reply = { ok?: boolean; error?: string; message?: string; review?: Record<string, number>; changed?: string[]; label?: string; change?: string; already?: number; full?: number; notOnList?: number; removed?: { email: string; label: string; at: number }[] };

async function main(): Promise<void> {
  part("The rules");
  is("added once, never twice, in any case", [labelsAfter(["VIP"], "vip", "add"), labelsAfter(["a"], "VIP", "add")], ["same", ["a", "VIP"]]);
  is("taken off in any case, or left", [labelsAfter(["Vip", "b"], "VIP", "remove"), labelsAfter(["b"], "VIP", "remove")], [["b"], "same"]);
  is("never past the most labels a contact holds", labelsAfter(Array.from({ length: 10 }, (_, i) => `t${i}`), "VIP", "add"), "skip");
  is("the undo is the opposite change", [opposite("add"), opposite("remove")], ["remove", "add"]);
  is("a removal keeps the label as that contact had it, and where", [removedFrom(["a", "Vip", "b"], "VIP"), removedFrom(["a"], "VIP")], [{ label: "Vip", at: 1 }, null]);
  is("its undo puts that very label back in its place, or at the end", [labelsAfter(["a", "b"], "VIP", "add", { label: "Vip", at: 1 }), labelsAfter(["a"], "VIP", "add", { label: "Vip", at: 5 })], [["a", "Vip", "b"], ["a", "Vip"]]);
  is("never a label other than the one named", labelsAfter(["a"], "VIP", "add", { label: "Other", at: 0 }), ["a", "VIP"]);
  is("an undo that took everything back says so", undoSummary(3, { changed: 2, already: 1, full: 0, notOnList: 0 }, "add"), { allBack: true, words: "Undone. Every contact is as it was." });
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
  is("the review says what it would do", review.body.review, { changes: 2, already: 1, notOnList: 1, full: 0, skipped: 1 });
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

  part("The screen");
  const html = renderToStaticMarkup(createElement(BulkLabels));
  is("every field labeled, with an example read with it", html.includes('<label for="bulk-text"') && html.includes("Their email addresses") && html.includes('aria-describedby="bulk-text-hint"') && html.includes('<label for="bulk-label"') && html.includes('aria-describedby="bulk-label-hint"'), true);
  is("what to do, as a group of choices", html.includes("<fieldset") && html.includes("<legend") && html.includes("Add the label") && html.includes("Take the label off"), true);
  is("says before confirming that no automation starts", html.includes("Adding a label here doesn&#x27;t start its automations."), true);
  is("a review first, its result in a status, refusals in an alert", html.includes("Review the change") && html.includes('role="status"') && html.includes('role="alert"'), true);
  const screen = readFileSync("components/bulk-labels.tsx", "utf8");

  part("The screen: accessibility (AAA audit, 4 Nov 2026)");
  is("no control is disabled while busy, so focus stays on it (2.4.3)", [/\sdisabled=\{/.test(screen), screen.includes("aria-disabled={busy || undefined}"), screen.includes("aria-disabled={busy || review.changes === 0 || undefined}")], [false, true, true]);
  is("a press while busy, or with nothing to change, does nothing", [screen.includes("if (busy) return;"), screen.includes("if (busy || !review || review.changes === 0) return;"), screen.includes("if (busy || !done) return;")], [true, true, true]);
  is("the live region holds one short sentence, not the review", [html.includes('<p role="status" class="sr-only"></p>'), /role="status"[^>]*>\s*\{review/.test(screen), screen.includes("{live}")], [true, false, true]);
  is("the review's title takes focus when it arrives", screen.includes('id="bulk-review-title" ref={reviewTitle} tabIndex={-1}') && screen.includes('focusNext.current = "review";'), true);
  is("after Apply, focus goes to Undo (or the done line); after Undo, to the form's title", [screen.includes('focusNext.current = changed.length ? "undo" : "done";'), screen.includes("ref={undoButton}"), screen.includes("ref={doneLine} tabIndex={-1}"), screen.includes('focusNext.current = "title";'), html.includes('id="bulk-title" tabindex="-1"')], [true, true, true, true, true]);
  is("focus is moved by refs, after the screen changed", screen.includes("useEffect(() => {") && screen.includes(".current?.focus();"), true);
  is("Undo says what it undoes", screen.includes('aria-describedby="bulk-done-line"'), true);
  is("a refusal is tied to its field: text, label or the choice (3.3.1)", ['none: "text"', 'many: "text"', 'label: "label"', 'change: "change"', 'aria-invalid={errorField === "text" || undefined}', 'aria-invalid={errorField === "label" || undefined}', '`bulk-${field}-error`'].every((piece) => screen.includes(piece)), true);
  is("shown next to the field, the end of the form keeps only the others", [html.includes('id="bulk-text-error" class="field-error mt-1 block" role="alert"'), html.includes('id="bulk-label-error"'), html.includes('id="bulk-change-error"'), screen.includes('{errorField ? "" : error}')], [true, true, true, true]);
  is("nothing is said twice: no toast beside the live line (4.1.3)", [screen.includes("toast("), screen.includes("@/components/toast")], [false, false]);
  is("a full store is said in plain words (3.1.5)", [screen.includes("data room"), screen.includes("Your store has no room left for more records. Delete some you no longer need first.")], [false, true]);
  is("the review lists how many, and that nothing is sent", screen.includes("will ${change === \"add\" ? \"get\" : \"lose\"} the label") && screen.includes("No automation starts and no email is sent. You can undo this right after."), true);
  is("anything typed after a review asks for a new one", screen.includes("setReview(null);"), true);
  is("the undo sends back exactly what changed, with each label as it was", screen.includes("change: undoing, emails: done.changed") && screen.includes("restore: done.removed") && screen.includes("const undoing = opposite(done.change);"), true);
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
