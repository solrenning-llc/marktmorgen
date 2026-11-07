/**
 * 537 [PH1], unit 3 (6 November 2026): the preview text in sequences, in the
 * email templates, and carried when a sent email is used again. Units 1 and 2
 * wrote the rules (lib/preheader.ts) and put them in one-off emails; this one
 * reuses them, with nothing new to send:
 *
 *   - a sequence's email (lib/flows.ts): checked when the sequence is saved,
 *     against that email's own subject, refused with the reason and nothing
 *     written; never kept on a step that acts instead of writing; read back
 *     strictly (lib/flow-list.ts), so a stored one its rules refuse is never
 *     read as none; and on every email the step sends, while a stored one its
 *     rules refuse stops the step rather than sending it without;
 *   - a sequence brought in from a file (lib/sequence-import.ts): the preview
 *     column is kept now, and one its rules refuse is reported, the email
 *     kept without it;
 *   - "Keep sending it" and "Write it again" (lib/mail-reuse.ts) carry the
 *     sent email's preview, and the studio's check of the copy refuses one its
 *     rules would not keep (lib/mail-response.ts);
 *   - the email templates (lib/mail-body.ts) each have a preview to write,
 *     marked like the rest of a template, which the library opens with;
 *   - the studio's sequence editor has the field, with its count and its
 *     problem, on every email of a sequence;
 *   - its cost: none new. A sequence's email is in the list-email line
 *     already, with the preview at its largest, and the sequences' record is
 *     held inside the store's data room.
 *
 * Synthetic store, list and sender only.
 */
import { readFileSync } from "node:fs";
import { MAX_PREVIEW, PREVIEW_PROBLEMS, cleanPreview } from "@/lib/preheader";
import { MAIL_TEMPLATES, hasPlaceholder } from "@/lib/mail-body";
import { enroll, readFlows, saveFlow, sendDueSteps, type Flow } from "@/lib/flows";
import { parseFlowList, readFlowListStrict } from "@/lib/flow-list";
import { readSequenceCsv } from "@/lib/sequence-import";
import { SEQUENCE_TEMPLATE } from "@/lib/sequence-template";
import { copyOf, planKeep } from "@/lib/mail-reuse";
import { confirmedMailCopy } from "@/lib/mail-response";
import { createBroadcast, advanceBroadcast, type Broadcast } from "@/lib/broadcasts";
import { csvLine } from "@/lib/csv";
import { upsertContact } from "@/lib/contacts";
import { claimHandle, ensureListId, ensureStatsId, setMailSettings, setSubscription, storeForEmail, storeForHandle } from "@/lib/store";
import { monthlyEmails } from "@/lib/plan";
import { COST_LINES, PER_EMAIL, PREVIEW_PER_EMAIL } from "./plan-cost-registry";
import { FAMILIES } from "./store-data-registry";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";
import { ROOM } from "./data-room";
import { installSesMailFixture } from "./ses-mail-fixture";

const OWNER = "owner@example.com";
const mail = installSesMailFixture({
  fallback: () => new Response(JSON.stringify({ object: "list", data: [], has_more: false })),
});
const PREHEADER = /<div aria-hidden="true" style="display:none;/;
const run = () => sendDueSteps((handle) => storeForHandle(handle), Date.now() + 20_000);

async function main(): Promise<void> {
  redis.clear();
  mail.configure();
  await mail.setReady(true, { max24: 50_000, rate: 100 });
  process.env.RESEND_API_KEY = "re_test_preview_only_a_stand_in";
  const made = await claimHandle(OWNER, "harbor", "Harbor Kitchen", "");
  if (!made.ok) throw new Error("no store");
  await ensureStatsId(OWNER);
  await ensureListId(OWNER);
  await setSubscription(OWNER, { customerId: "cus_Owner00001", subscriptionId: "sub_Owner00001", active: true, tier: "pro", period: paidPeriod() });
  await setMailSettings(OWNER, { fromName: "Harbor Kitchen", address: "1 Main St, Portland, OR 97201" });
  const store = (await storeForEmail(OWNER))!;
  const listId = store.listId as string;
  const flowsKey = `nl:mail:flows:${listId}`;

  part("A sequence's email: refused with the reason, nothing written");
  const sequence = (preview: unknown, subject = "Welcome") => ({
    name: "Welcome",
    trigger: "joined",
    steps: [{ delayHours: 0, subject, body: "Hello.", preview }],
  });
  const refusals: string[] = [];
  for (const preview of ["Read it at example.com", "<b>New</b>", "a".repeat(MAX_PREVIEW + 1), "welcome", "a" + "́".repeat(7_000)]) {
    const r = await saveFlow(store, sequence(preview));
    refusals.push(r.ok ? "saved" : r.reason);
  }
  is("each refused with its own reason, against that email's own subject", refusals, ["preview_link", "preview_markup", "preview_long", "preview_subject", "preview_heavy"]);
  is("a part of a template left to write is never sent", (await saveFlow(store, sequence("⟦One line about what is inside⟧"))).ok ? "saved" : "refused", "refused");
  is("nothing written for any of them", redis.run(["GET", flowsKey]), null);

  part("A sequence's email: kept, read back strictly, sent on every email");
  const saved = await saveFlow(store, {
    name: "Welcome",
    trigger: "joined",
    steps: [
      { delayHours: 0, subject: "Welcome", body: "Hello.", preview: "  Three   dinners\nfor busy weeks " },
      { delayHours: 0, action: { do: "tag", tag: "welcomed" }, preview: "Words a step that acts never sends" },
      { delayHours: 0, subject: "One more", body: "That is all." },
    ],
  }, { activate: true });
  if (!saved.ok) throw new Error(`no sequence: ${saved.reason}`);
  const mine = saved.flows.at(-1)!;
  const steps = mine.steps;
  is("kept tidied on its email", steps[0].preview, "Three dinners for busy weeks");
  is("never on a step that acts", "preview" in steps[1], false);
  is("absent on an email without one", "preview" in steps[2], false);
  is("read back strictly, as the studio reads it", (await readFlowListStrict(listId)).at(-1)!.steps.map((s) => s.preview ?? null), ["Three dinners for busy weeks", null, null]);
  is("and as the sender reads it", (await readFlows(listId)).at(-1)!.steps[0].preview, "Three dinners for busy weeks");
  const resaved = await saveFlow(store, { ...mine } as unknown as Record<string, unknown>);
  is("an edit that sends the sequence back keeps it", resaved.ok && resaved.flows.find((f) => f.id === mine.id)?.steps[0].preview, "Three dinners for busy weeks");

  for (const name of ["ana", "ben"]) {
    await upsertContact(listId, `${name}@example.com`, { agreed: true, explicit: true, source: "free" }, ROOM);
    await enroll(store, `${name}@example.com`, { joined: true });
  }
  mail.clearCaptured();
  for (let i = 0; i < 4; i += 1) await run();
  const welcome = mail.sent.filter((m) => m.subject === "Welcome");
  const after = mail.sent.filter((m) => m.subject === "One more");
  is("the email went to both", welcome.length, 2);
  is("every email carries it first in the body", welcome.map((m) => /<body[^>]*><div aria-hidden="true"[^>]*><span style="mso-hide:all">Three dinners for busy weeks<\/span>/.test(m.html)), [true, true]);
  is("and as the first line of its text", welcome.map((m) => m.text.startsWith("Three dinners for busy weeks\n\nHello.")), [true, true]);
  is("an email of the sequence without one goes out as before", after.map((m) => PREHEADER.test(m.html) || !m.text.startsWith("That is all.")), [false, false]);

  part("A stored preview that its rules would not keep is never read as none");
  const original = redis.run(["GET", flowsKey]) as string;
  const withStored = (preview: unknown, at = 0) => {
    const list = JSON.parse(original) as Flow[];
    (list.at(-1)!.steps[at] as unknown as Record<string, unknown>).preview = preview;
    return list;
  };
  for (const bad of [42, "see example.com", "", "Welcome"]) {
    is(`the strict reader refuses a stored preview of ${JSON.stringify(bad)}`, parseFlowList(withStored(bad)), null);
  }
  is("and one on a step that acts", parseFlowList(withStored("Three dinners", 1)), null);
  is("a sequence from before the field reads as it did", parseFlowList(JSON.parse(original.replace(/,"preview":"Three dinners for busy weeks"/, "")))?.at(-1)?.steps[0].preview, undefined);
  redis.run(["SET", flowsKey, JSON.stringify(withStored("see example.com"))]);
  await upsertContact(listId, "cy@example.com", { agreed: true, explicit: true, source: "free" }, ROOM);
  const started = redis.keys().filter((k) => k.startsWith("nl:mail:enr:")).length;
  await enroll(store, "cy@example.com", { joined: true });
  is("the person was started on the sequence", redis.keys().filter((k) => k.startsWith("nl:mail:enr:")).length, started + 1);
  mail.clearCaptured();
  await run();
  is("the email is not sent without it", mail.sent.filter((m) => m.to.includes("cy@example.com")).length, 0);
  redis.run(["SET", flowsKey, original]);
  for (let i = 0; i < 3; i += 1) await run();
  is("nor sent later as if nothing happened: that run ended there", mail.sent.filter((m) => m.to.includes("cy@example.com")).length, 0);

  part("A sequence brought in from a file keeps its preview");
  is("the template's preview column", SEQUENCE_TEMPLATE.includes("preview"), true);
  const csv = [
    csvLine(["order", "days_after", "subject", "preview", "body"]),
    csvLine(["1", "0", "Welcome", "  Three dinners  for busy weeks ", "Hello."]),
    csvLine(["2", "1", "Next", "See it at example.com", "More."]),
    csvLine(["3", "1", "Last", "", "Bye."]),
  ].join("\n");
  const read = readSequenceCsv(csv);
  if (!read.ok) throw new Error(`not read: ${read.why}`);
  is("kept tidied on its email", read.steps.map((s) => s.preview ?? null), ["Three dinners for busy weeks", null, null]);
  is("one its rules refuse is reported, in its words, and the email kept without it", read.report.filter((r) => r.column === "preview").map((r) => [r.line, r.reason.startsWith(PREVIEW_PROBLEMS.link)]), [[3, true]]);
  is("nothing says the preview is not kept any more", read.report.some((r) => /not kept yet/.test(r.reason)), false);

  part("Keep sending it, and Write it again");
  const sent = (over: Partial<Broadcast> = {}): Broadcast => ({
    id: "a".repeat(24), listId, handle: "harbor", subject: "The plan is here", body: "Hello.", productId: null, notProductId: null, who: "all", narrow: null,
    status: "sent", createdAt: 1, sendAt: 1, finishedAt: 2, total: 10, sent: 10, note: "", failures: 0, listed: true, tagged: false, test: null, ...over,
  });
  const plan = planKeep(sent({ preview: "Five weeks, one page" }), listId, [], null);
  is("the kept email keeps its preview", plan.ok && (plan.raw.steps as Record<string, unknown>[])[0].preview, "Five weeks, one page");
  const bare = planKeep(sent(), listId, [], null);
  is("and an email without one adds none", bare.ok && "preview" in (bare.raw.steps as Record<string, unknown>[])[0], false);

  const created = await createBroadcast(store, { subject: "The plan is here", body: "Hello.", productId: "", notProductId: "", sendAt: undefined, preview: "Five weeks, one page" });
  if (!created.ok) throw new Error(`no broadcast: ${created.reason}`);
  await advanceBroadcast(created.broadcast.id, storeForHandle, Date.now() + 60_000);
  const copy = await copyOf(store, created.broadcast.id);
  is("the copy to write again has it", copy?.preview, "Five weeks, one page");
  const answer = (preview?: unknown) => ({ ok: true, copy: { subject: "S", body: "B", productId: null, who: "all", notProductId: null, narrow: null, ...(preview === undefined ? {} : { preview }) } });
  is("the studio takes the copy's preview", confirmedMailCopy(answer("Five weeks, one page"))?.preview, "Five weeks, one page");
  is("a copy without one has none", confirmedMailCopy(answer()) !== null && !("preview" in confirmedMailCopy(answer())!), true);
  is("a copy with one its rules refuse is not confirmed", [confirmedMailCopy(answer("see example.com")), confirmedMailCopy(answer(42)), confirmedMailCopy(answer(""))], [null, null, null]);

  part("The email templates");
  is("each has a preview to write, marked like the rest of it", MAIL_TEMPLATES.map((t) => typeof t.preview === "string" && hasPlaceholder(t.preview)), MAIL_TEMPLATES.map(() => true));
  is("each one is a preview its rules keep, exactly", MAIL_TEMPLATES.map((t) => { const r = cleanPreview(t.preview); return r.ok && r.text === t.preview; }), MAIL_TEMPLATES.map(() => true));
  is("none hurries the reader", MAIL_TEMPLATES.some((t) => /\b(once a year|deals inside|hurry|last chance|only today|ends tonight)\b/i.test(t.preview)), false);
  const page = readFileSync("app/studio/email/page.tsx", "utf8");
  const intents = readFileSync("lib/template-library-intents.ts", "utf8");
  is("the library opens the composer with it", [/initialTemplate=\{emailTemplate \? \{[^}]*preview:emailTemplate\.preview/.test(page), /LibraryEmailDraft=\{[^}]*preview\?:string/.test(intents)], [true, true]);

  part("The studio's sequence editor");
  const studio = readFileSync("components/email-studio.tsx", "utf8");
  is("the composer starts from a template's preview", /useState\([^;]*props\.draft\?\.preview \?\? props\.initialTemplate\?\.preview \?\? ""\)/.test(studio), true);
  is("Write it again opens with the copy's preview", /onOpen\(\{[^}]*copy\.preview/.test(studio), true);
  is("every email of a sequence has the field, its count and its problem", [/<PreviewTextField\b[^>]*id=\{`step-preview-\$\{s\.editorKey\}`\}/.test(studio), /function PreviewTextField\b/.test(studio)], [true, true]);
  is("the field has a visible label, a count tied to it, announced, and its problem in words", [/<span className="[^"]*">Preview text<\/span>/.test(studio), /aria-describedby=\{`\$\{id\}-count \$\{id\}-hint \$\{id\}-problem`\}/.test(studio), /id=\{`\$\{id\}-count`\}[^>]*aria-live="polite"/.test(studio), /PREVIEW_PROBLEMS\[problem\]/.test(studio)], [true, true, true, true]);
  is("it goes with the saved sequence, only on an email", /delayHours: flowWaitHours\(s\.wait, s\.unit\)!,[\s\S]{0,200}\.\.\.\(!action && s\.preview\.trim\(\) \? \{ preview: s\.preview \} : \{\}\)/.test(studio), true);
  is("an opened sequence and one brought in from a file show theirs", [/preview: s\.preview \?\? ""/.test(studio), /preview: s\.preview \?\? "",\s*\}\)\),/.test(studio)], [true, true]);
  is("saving waits while an email's preview has a problem", /stepPreviewProblem/.test(studio) && /disabled=\{[^}]*previewBlocked/.test(studio), true);

  part("What it costs");
  const line = COST_LINES.find((l) => l.id === "list-email");
  is("a sequence's email is a monthly email, in the list-email line", /sequences/.test(line?.feature ?? ""), true);
  is("that line counts each with its preview at its largest, on every tier", (["creator", "pro", "scale"] as const).map((t) => Math.abs((line?.monthlyUsd(t) ?? 0) - monthlyEmails(t) * (PER_EMAIL + PREVIEW_PER_EMAIL)) < 1e-12), [true, true, true]);
  is("the sequences' record is held inside the store's data room", FAMILIES["nl:mail:flows:@lib/flows.ts"]?.room, ["lib/flows.ts"]);

  mail.restore();
  done();
}

void main();
