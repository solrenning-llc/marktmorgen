/**
 * 537 [PH1], unit 2 (6 November 2026): the preview text in one-off emails.
 * Unit 1 wrote the rules (lib/preheader.ts); this unit puts them to work:
 *
 *   - a byte ceiling besides the 120 characters, since a single character as
 *     a reader counts it can carry any number of marks, so 120 of them were
 *     not a bound on what is kept and sent;
 *   - the email as sent (lib/mail.ts render): the preview first in the HTML
 *     body, right after <body>, and first line of the text; without one the
 *     email is exactly what it was;
 *   - one-off emails (lib/broadcasts.ts): checked when the email is written
 *     down, refused with the reason and nothing written, kept on its record,
 *     read back strictly, and on every email of every batch;
 *   - the studio's answer checker (lib/broadcast-response.ts): a server that
 *     lost or changed the preview is not a confirmed email;
 *   - drafts (lib/mail-drafts.ts): kept with the draft, refused as the send is;
 *   - the studio composer and the route carry it to all three;
 *   - its cost, in the list-email line of tests/plan-cost-registry.ts.
 *
 * Synthetic store, list and sender only.
 */
import { readFileSync } from "node:fs";
import { MAX_PREVIEW, MAX_PREVIEW_BYTES, PREVIEW_PROBLEMS, cleanPreview, withPreheader } from "@/lib/preheader";
import { render } from "@/lib/mail";
import { claimHandle, ensureListId, ensureStatsId, setMailSettings, setSubscription, storeForEmail, storeForHandle } from "@/lib/store";
import { upsertContact } from "@/lib/contacts";
import { advanceBroadcast, createBroadcast, listBroadcastsStrict, readBroadcast } from "@/lib/broadcasts";
import { broadcastAnswer } from "@/lib/broadcast-response";
import { listDraftsStrict, saveDraft } from "@/lib/mail-drafts";
import { monthlyEmails } from "@/lib/plan";
import { COST_LINES, PER_EMAIL, PREVIEW_PER_EMAIL } from "./plan-cost-registry";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";
import { ROOM } from "./data-room";
import { installSesMailFixture } from "./ses-mail-fixture";

const OWNER = "owner@example.com";
const delivery = installSesMailFixture();
const cp = (...codes: number[]) => String.fromCodePoint(...codes);
const ZWJ = cp(0x200d);
/** A family with four skin tones: one character as a reader counts it, 41 bytes. */
const TONED_FAMILY = [cp(0x1f468, 0x1f3fb), cp(0x1f469, 0x1f3fb), cp(0x1f467, 0x1f3fb), cp(0x1f466, 0x1f3fb)].join(ZWJ);
const PREHEADER = /<div aria-hidden="true" style="display:none;/;

async function main(): Promise<void> {
  part("A byte ceiling besides the 120 characters");
  const marks = "a" + "́".repeat(5_000);
  is("one character carrying thousands of marks is one character to a reader", cleanPreview(marks).ok ? "kept" : "refused", "refused");
  is("it is refused as too heavy, never cut", cleanPreview(marks), { ok: false, why: "heavy" });
  is("the heavy problem has its plain words", typeof PREVIEW_PROBLEMS.heavy === "string" && PREVIEW_PROBLEMS.heavy.length > 20, true);
  is("120 of the longest emoji a person types are still kept", cleanPreview(TONED_FAMILY.repeat(MAX_PREVIEW)).ok, true);
  is("the ceiling holds 120 of them with room", new TextEncoder().encode(TONED_FAMILY).length * MAX_PREVIEW <= MAX_PREVIEW_BYTES, true);
  is("just past the ceiling is refused", cleanPreview("e" + "́".repeat(MAX_PREVIEW_BYTES)), { ok: false, why: "heavy" });

  part("Placed right after <body>");
  is("nothing added without a preview", withPreheader("<html><body style=\"x\">Hi</body></html>", ""), "<html><body style=\"x\">Hi</body></html>");
  is("first thing in the body", withPreheader("<html><body style=\"x\">Hi</body></html>", "Three dinners").startsWith("<html><body style=\"x\"><div aria-hidden=\"true\""), true);
  is("a page without a body gets it first", withPreheader("<p>Hi</p>", "Three dinners").startsWith("<div aria-hidden=\"true\""), true);
  is("one its rules refuse adds nothing", withPreheader("<body>Hi</body>", "see example.com"), "<body>Hi</body>");

  redis.clear();
  delivery.configure();
  delivery.reset();
  process.env.RESEND_API_KEY = "re_test_preview_only_a_stand_in";
  const made = await claimHandle(OWNER, "harbor", "Harbor Kitchen", "");
  if (!made.ok) throw new Error("no store");
  await ensureStatsId(OWNER);
  await ensureListId(OWNER);
  await setSubscription(OWNER, { customerId: "cus_Owner00001", subscriptionId: "sub_Owner00001", active: true, tier: "pro", period: paidPeriod() });
  await setMailSettings(OWNER, { fromName: "Harbor Kitchen", address: "1 Main St, Portland, OR 97201" });
  const store = (await storeForEmail(OWNER))!;
  const listId = store.listId as string;
  for (const name of ["ana", "ben", "cy"]) await upsertContact(listId, `${name}@example.com`, { agreed: true, explicit: true, source: "free" }, ROOM);

  part("The email as sent");
  const plain = render(store, "News", "Hello.\n\nIt is open.", "tok_synthetic");
  const withIt = render(store, "News", "Hello.\n\nIt is open.", "tok_synthetic", undefined, undefined, undefined, "Three dinners & a list");
  is("without a preview the email is what it was", [PREHEADER.test(plain.html), plain.text.startsWith("Hello.")], [false, true]);
  is("with one, the HTML is the same email with the preview right after <body>", withIt.html, withPreheader(plain.html, "Three dinners & a list"));
  is("and escaped there", withIt.html.includes("<span style=\"mso-hide:all\">Three dinners &amp; a list</span>"), true);
  is("the text version's first line is the preview, then the email as it was", withIt.text, `Three dinners & a list\n\n${plain.text}`);
  is("subject and headers unchanged", [withIt.subject, JSON.stringify(withIt.headers)], [plain.subject, JSON.stringify(plain.headers)]);

  part("One-off emails: refused with the reason, nothing written");
  const before = redis.keys().filter((k) => k.startsWith("nl:mail:bc:")).length;
  const refusals: string[] = [];
  for (const preview of ["Read it at example.com", "<b>New</b>", "a".repeat(MAX_PREVIEW + 1), "News", marks]) {
    const r = await createBroadcast(store, { subject: "News", body: "Hello.", productId: "", notProductId: "", sendAt: undefined, preview });
    refusals.push(r.ok ? "made" : r.reason);
  }
  is("each refused with its own reason", refusals, ["preview_link", "preview_markup", "preview_long", "preview_subject", "preview_heavy"]);
  const sameAsB = await createBroadcast(store, { subject: "News", body: "Hello. https://marktmorgen.com/@harbor", productId: "", notProductId: "", sendAt: undefined, preview: "Fresh bread", test: { subjectB: "Fresh bread", share: 20, hours: 4, by: "visits" } });
  is("the second subject of a test is a subject too", sameAsB.ok ? "made" : sameAsB.reason, "preview_subject");
  is("nothing written for any of them", redis.keys().filter((k) => k.startsWith("nl:mail:bc:")).length, before);

  part("One-off emails: kept, read back, sent on every email");
  const created = await createBroadcast(store, { subject: "News", body: "Hello.", productId: "", notProductId: "", sendAt: undefined, preview: "  Three   dinners\nfor busy weeks " });
  if (!created.ok) throw new Error(`no broadcast: ${created.reason}`);
  is("kept tidied on the record", created.broadcast.preview, "Three dinners for busy weeks");
  is("read back", (await readBroadcast(created.broadcast.id))?.preview, "Three dinners for busy weeks");
  is("read back strictly, as the studio and the sender read it", (await listBroadcastsStrict(listId)).find((b) => b.id === created.broadcast.id)?.preview, "Three dinners for busy weeks");
  delivery.clearCaptured();
  const sent = (await advanceBroadcast(created.broadcast.id, storeForHandle, Date.now() + 60_000))!;
  is("sent to everybody", [sent.status, sent.sent], ["sent", 3]);
  is("every email carries it first in the body", delivery.sent.map((m) => /<body[^>]*><div aria-hidden="true"[^>]*><span style="mso-hide:all">Three dinners for busy weeks<\/span>/.test(m.html)), [true, true, true]);
  is("and as the first line of its text", delivery.sent.map((m) => m.text.startsWith("Three dinners for busy weeks\n\nHello.")), [true, true, true]);

  const none = await createBroadcast(store, { subject: "News again", body: "Hello.", productId: "", notProductId: "", sendAt: undefined });
  if (!none.ok) throw new Error(`no broadcast: ${none.reason}`);
  is("with no preview, none on the record", "preview" in none.broadcast, false);
  delivery.clearCaptured();
  await advanceBroadcast(none.broadcast.id, storeForHandle, Date.now() + 60_000);
  is("and the emails go out as before", delivery.sent.map((m) => PREHEADER.test(m.html) || !m.text.startsWith("Hello.")), [false, false, false]);

  part("A stored preview that its rules would not keep is never read as none");
  const id = none.broadcast.id;
  const key = `nl:mail:bc:${id}`;
  const original = redis.run(["GET", key]) as string;
  for (const bad of [42, "see example.com", ""]) {
    redis.run(["SET", key, JSON.stringify({ ...JSON.parse(original), preview: bad })]);
    let failed = false;
    try { await listBroadcastsStrict(listId); } catch { failed = true; }
    is(`the strict reader refuses a stored preview of ${JSON.stringify(bad)}`, failed, true);
  }
  redis.run(["SET", key, original]);
  is("an email from before the field reads as it did", (await listBroadcastsStrict(listId)).some((b) => b.id === id && !("preview" in b)), true);

  part("The studio's check of the answer");
  const input = { subject: "News", body: "Hello.", productId: "", notProductId: "", who: "all", preview: "Three dinners" };
  const answer = (preview?: string) => ({ ok: true, broadcast: { id: "a".repeat(24), status: "scheduled", createdAt: 10, sendAt: 10, total: 3, sent: 0, subject: "News", body: "Hello.", productId: null, notProductId: null, who: "all", narrow: null, test: null, ...(preview === undefined ? {} : { preview }) } });
  is("the preview as asked: confirmed", broadcastAnswer(true, answer("Three dinners"), input).ok, true);
  is("lost by the server: not confirmed", broadcastAnswer(true, answer(), input), { ok: false, error: "broadcast_write_unconfirmed" });
  is("changed by the server: not confirmed", broadcastAnswer(true, answer("Other words"), input), { ok: false, error: "broadcast_write_unconfirmed" });
  is("one not asked for: not confirmed", broadcastAnswer(true, answer("Three dinners"), { ...input, preview: "" }), { ok: false, error: "broadcast_write_unconfirmed" });
  is("a refusal for a preview is passed on as said", broadcastAnswer(false, { ok: false, error: "preview_link" }, input), { ok: false, error: "preview_link" });

  part("Drafts keep it");
  const draft = await saveDraft(store, OWNER, { subject: "Draft", body: "Hello.", productId: "", preview: "Three dinners" });
  if (!draft.ok) throw new Error(`no draft: ${draft.reason}`);
  is("saved with the draft", draft.draft.preview, "Three dinners");
  is("listed with it", (await listDraftsStrict(listId)).find((d) => d.id === draft.draft.id)?.preview, "Three dinners");
  const kept = await saveDraft(store, OWNER, { id: draft.draft.id, subject: "Draft", body: "Hello again.", productId: "", expectedSavedAt: draft.draft.savedAt });
  is("an update that does not send it keeps it", kept.ok && kept.draft.preview, "Three dinners");
  const cleared = kept.ok ? await saveDraft(store, OWNER, { id: draft.draft.id, subject: "Draft", body: "Hello again.", productId: "", preview: "", expectedSavedAt: kept.draft.savedAt }) : null;
  is("an empty one clears it", cleared?.ok && "preview" in cleared.draft, false);
  const refused = await saveDraft(store, OWNER, { subject: "Draft", body: "Hello.", productId: "", preview: "see example.com" });
  is("refused as the send refuses it", refused.ok ? "saved" : refused.reason, "preview_link");

  part("The studio and the route carry it");
  const studio = readFileSync("components/email-studio.tsx", "utf8");
  const route = readFileSync("app/api/store/mail/route.ts", "utf8");
  is("a short visible label, the field tied to its hint, its count and its problem", [/<label className="block" htmlFor="mail-preview">\s*<span className="field-label">Preview text<\/span>\s*<\/label>/.test(studio), /id="mail-preview"[^>]*aria-describedby="mail-preview-hint mail-preview-count mail-preview-problem"/.test(studio)], [true, true]);
  is("the hint is outside the label, so the field's name stays short and the hint is read once", /<\/label>\s*<p className="field-hint mt-1" id="mail-preview-hint">/.test(studio), true);
  is("the count is the reader's count, not announced at every key; going past the limit is, by the problem line", [/previewLength\(preview\b/.test(studio), /id="mail-preview-count"[^>]*aria-live/.test(studio), /id="mail-preview-problem"[^>]*aria-live="polite"/.test(studio), studio.includes("MAX_PREVIEW")], [true, false, true, true]);
  is("its problem is said in words, beside it, and marks it invalid", [/aria-invalid=\{previewProblem \? true : undefined\}/.test(studio), studio.includes("PREVIEW_PROBLEMS[previewProblem]")], [true, true]);
  is("it goes with the send, the test and the draft", [/action: "broadcast",[\s\S]{0,700}preview,/.test(studio), /action: "test", subject, body, preview \}/.test(studio), /action: "draft-save"[^}]*preview[,\s]/.test(studio)], [true, true, true]);
  is("it is kept when the composer is set aside, and counts as unsaved work", [/type ComposerSnapshot = \{[\s\S]{0,200}preview: string;/.test(studio), /const snapshot = \(\): ComposerSnapshot => \(\{[^)]*preview,/.test(studio)], [true, true]);
  is("sending and saving wait while it has a problem", (studio.match(/Boolean\(previewProblem\)/g) ?? []).length >= 3, true);
  is("the send's answer passes a blank preview's refusal on as it is", readFileSync("lib/broadcast-response.ts", "utf8").includes('"preview_blank"'), true);
  is("each refusal has its words in the studio", ["preview_long", "preview_markup", "preview_link", "preview_subject", "preview_heavy", "preview_blank"].every((r) => new RegExp(`${r}: PREVIEW_PROBLEMS\\.`).test(studio)), true);
  is("the route passes it to the send, the test and the draft", [/createBroadcast\(store, \{[\s\S]{0,900}preview: previewOf\(body\.preview\)/.test(route), /action === "test"[\s\S]{0,900}cleanPreview\(/.test(route), /saveDraft\(store, email, \{[\s\S]{0,600}preview: /.test(route)], [true, true, true]);

  part("What it costs");
  const line = COST_LINES.find((l) => l.id === "list-email");
  is("a positive amount for each list email", PREVIEW_PER_EMAIL > 0, true);
  is("in the list-email line, for every tier", (["creator", "pro", "scale"] as const).map((t) => Math.abs((line?.monthlyUsd(t) ?? 0) - monthlyEmails(t) * (PER_EMAIL + PREVIEW_PER_EMAIL)) < 1e-12), [true, true, true]);
  is("the line names the ceilings it rests on", line?.sources.some((s) => s.file === "lib/preheader.ts" && s.names.includes("MAX_PREVIEW_BYTES")), true);

  delivery.restore();
  done();
}

void main();
