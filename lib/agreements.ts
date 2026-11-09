/**
 * Proposals and agreements, on the wire: the email that brings one to the
 * person it is for, and the signed copy both sides receive
 * (lib/agreement-rules.ts says what one is, lib/agreement-store.ts where it is
 * kept).
 *
 * Every email here is one of the store's own emails for the month
 * (lib/store-allowance-rules.ts, "email"), taken before it goes: one that
 * does not fit is not sent, and the creator is told why. The signed copy is
 * the exact text signed and what was recorded, in the email itself and as an
 * HTML file attached to it, and the page it links to can be printed or saved
 * as PDF. Nothing here costs anything a store's emails, its data room and its
 * store commands do not already count.
 */
import { sendEmailOutcome } from "@/lib/email";
import { fromStore, storeBase } from "@/lib/purchase-email";
import { speechFor } from "@/lib/buyer-words";
import { type AgreementWords, agreementWords } from "@/lib/buyer-words/agreements";
import { type Store } from "@/lib/store";
import { type Agreement, type AgreementVersion, type Signature, MAX_SENDS, canSendAgain, latestOf } from "@/lib/agreement-rules";
import { agreementOf, changeAgreement, readVersion } from "@/lib/agreement-store";

/** Where an agreement is read and signed: the store's own address or domain, /sign/<id>. */
export function agreementLink(store: Store, a: Pick<Agreement, "id">): string {
  return `${storeBase(store)}/sign/${a.id}`;
}

const NOT_SENT = "Not sent: your store's emails for this month may be used, or email could not be sent just now. You can send it again from here.";
/**
 * Said when an email's send is not known (a timeout, a 5xx, a network error
 * after the request may have reached the sender): it may have arrived, so it
 * is never said "Not sent", and it counts as one of the agreement's emails,
 * so its count, the day before another and the next email's own key all
 * move on and nothing sends it twice (9 November 2026, rule 30).
 */
const UNCONFIRMED = "We could not confirm it was sent. It may still arrive; check before sending again.";

/**
 * Emails the link to the person it is for: the first version, a new version,
 * or the same version again by hand. From the store's name, with replies
 * going to the creator; taken from the store's emails for the month before it
 * goes. Writes down when it went, or why it did not.
 */
export async function sendAgreementEmail(store: Store, a: Agreement, version: AgreementVersion, now = Date.now()): Promise<{ sent: boolean; uncertain?: true; agreement: Agreement }> {
  if (a.sent.length >= MAX_SENDS) return { sent: false, agreement: a };
  const w = agreementWords(store.language);
  const said = speechFor(store.language, version.currency);
  const fresh = version.n > 1;
  const text = [
    w.greeting(a.name),
    "",
    fresh ? w.newVersionLead(store.name, version.n) : w.emailLead(store.name),
    "",
    `${w.text.kind[a.kind]}: ${version.title}`,
    "",
    w.emailLink,
    agreementLink(store, a),
    w.until(said.date(a.expiresAt)),
    "",
    w.emailIgnore,
    w.replyReaches(store.name),
    "",
    w.footer(store.name),
  ].join("\n");
  const outcome = await sendEmailOutcome({
    meter: { by: "store", store, kind: "email" },
    from: fromStore(store),
    to: a.email,
    replyTo: store.email,
    subject: (fresh ? w.newVersionSubject(store.name, version.title, version.n) : w.subject(store.name, a.kind, version.title)).slice(0, 180),
    text,
    idempotencyKey: `nimbus-agree:${a.id}:${a.sent.length}`,
  }).catch(() => "uncertain" as const);
  // Written onto the record as it is now: a signature or a version given
  // while the email was on its way stays (MM-SA-03). Not known: counted and said so (UNCONFIRMED).
  const next = await changeAgreement(store, a.id, (current) => (outcome === "refused" ? { ...current, failed: NOT_SENT } : { ...current, sent: [...current.sent, now], failed: outcome === "sent" ? "" : UNCONFIRMED }), now);
  return outcome === "uncertain" ? { sent: false, uncertain: true, agreement: next ?? a } : { sent: outcome === "sent", agreement: next ?? a };
}

/** One more email of the link by hand, within the same counts (lib/agreement-rules.ts, canSendAgain). */
export async function sendAgain(store: Store, id: string, now = Date.now()): Promise<{ ok: true; sent: boolean; uncertain?: true } | { ok: false; why: string }> {
  const a = await agreementOf(store, id);
  if (!a) return { ok: false, why: "That agreement is gone. Reload the page." };
  const may = canSendAgain(a, now);
  if (!may.ok) return may;
  const latest = latestOf(a);
  const version = latest ? await readVersion(a, latest.n) : null;
  if (!version) return { ok: false, why: "That agreement can't be read right now. Try again in a minute." };
  const done = await sendAgreementEmail(store, a, version, now);
  return done.uncertain ? { ok: true, sent: false, uncertain: true } : { ok: true, sent: done.sent };
}

const escape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** What was recorded, as lines of text, in the store's language. */
function recordLines(w: AgreementWords, version: AgreementVersion, signature: Signature): [string, string][] {
  return [
    [w.signedBy, signature.name],
    [w.signedAt, new Date(signature.at).toISOString().replace("T", " ").slice(0, 19)],
    [w.versionLabel, String(version.n)],
    [w.fingerprint, signature.sha256],
    [w.consentLabel, signature.consent],
    [w.ipLabel, signature.ipHash ? w.ipRecorded : w.ipNone],
  ];
}

/**
 * The signed copy as one HTML file: the exact text signed, unchanged, and
 * what was recorded. Plain, with no script and nothing loaded from anywhere,
 * so it opens the same in any browser and can be kept or printed.
 */
export function signedCopyHtml(store: Store, a: Agreement, version: AgreementVersion, signature: Signature): string {
  const w = agreementWords(store.language);
  const rows = recordLines(w, version, signature)
    .map(([k, v]) => `<tr><th scope="row" style="text-align:left;padding:4px 12px 4px 0;vertical-align:top">${escape(k)}</th><td style="padding:4px 0;word-break:break-all">${escape(v)}</td></tr>`)
    .join("");
  return [
    "<!doctype html>",
    `<html lang="${escape(String(store.language || "en"))}"><head><meta charset="utf-8"><title>${escape(`${w.text.kind[a.kind]}: ${version.title}`)}</title></head>`,
    '<body style="font-family:Georgia,serif;max-width:720px;margin:40px auto;padding:0 16px;color:#111">',
    `<h1 style="font-size:22px">${escape(`${w.text.kind[a.kind]}: ${version.title}`)}</h1>`,
    `<h2 style="font-size:16px">${escape(w.textHeading)}</h2>`,
    `<pre style="white-space:pre-wrap;font-family:inherit;font-size:15px;line-height:1.5;border:1px solid #ccc;padding:16px">${escape(version.text)}</pre>`,
    `<h2 style="font-size:16px">${escape(w.copyRecord)}</h2>`,
    `<table style="font-size:14px;border-collapse:collapse">${rows}</table>`,
    `<p style="font-size:13px;color:#444">${escape(w.recorded)}</p>`,
    `<p style="font-size:13px;color:#444">${escape(w.enforce(store.name))}</p>`,
    "</body></html>",
  ].join("\n");
}

/**
 * The signed copy, to the person who signed and to the creator: the exact
 * text signed and what was recorded, in the email and as an HTML file
 * attached, with the link to the record's page. Each is one of the store's
 * emails for the month; one that does not fit is not sent, and the page
 * still shows the record and can be printed.
 */
export async function sendSignedCopies(store: Store, a: Agreement, version: AgreementVersion, signature: Signature, now = Date.now()): Promise<{ signer: boolean; creator: boolean }> {
  const w = agreementWords(store.language);
  const said = speechFor(store.language, version.currency);
  const html = signedCopyHtml(store, a, version, signature);
  const attachments = [{ filename: `signed-${a.id.slice(0, 8)}-v${version.n}.html`, content: Buffer.from(html, "utf8").toString("base64") }];
  const body = (lead: string) =>
    [
      lead,
      "",
      `--- ${w.textHeading} ---`,
      version.text,
      "---",
      "",
      `${w.copyRecord}:`,
      ...recordLines(w, version, signature).map(([k, v]) => `${k}: ${v}`),
      "",
      w.recorded,
      w.enforce(store.name),
      "",
      w.copyPage,
      agreementLink(store, a),
      "",
      w.footer(store.name),
    ].join("\n");
  const date = said.date(signature.at);
  const subject = w.copySubject(store.name, version.title).slice(0, 180);
  const signer = await sendEmailOutcome({
    meter: { by: "store", store, kind: "email" },
    from: fromStore(store),
    to: a.email,
    replyTo: store.email,
    subject,
    text: [w.greeting(a.name), "", body(w.copyLead(signature.name, date))].join("\n"),
    attachments,
    idempotencyKey: `nimbus-agree-copy:${a.id}:${version.n}:signer`,
  }).catch(() => "uncertain" as const);
  const creator = store.email
    ? await sendEmailOutcome({
        meter: { by: "store", store, kind: "email" },
        from: fromStore(store),
        to: store.email,
        subject,
        text: body(w.copyCreatorLead(signature.name, a.email, date)),
        attachments,
        idempotencyKey: `nimbus-agree-copy:${a.id}:${version.n}:creator`,
      }).catch(() => "uncertain" as const)
    : "refused";
  // A copy counts as sent only when a sender took it; the signer's whose send is not known is said so (UNCONFIRMED).
  const copied = (signer === "sent" ? 1 : 0) + (creator === "sent" ? 1 : 0);
  const failed = signer === "sent" ? "" : signer === "uncertain" ? UNCONFIRMED : NOT_SENT;
  await changeAgreement(store, a.id, (current) => ({ ...current, copies: current.copies + copied, failed }), now).catch(() => undefined);
  return { signer: signer === "sent", creator: creator === "sent" };
}

/** The signed copy of the latest signed version, to the person who signed, once more by hand: one of the agreement's emails. */
export async function resendSignedCopy(store: Store, id: string, now = Date.now()): Promise<{ ok: true; sent: boolean; uncertain?: true } | { ok: false; why: string }> {
  const a = await agreementOf(store, id);
  if (!a) return { ok: false, why: "That agreement is gone. Reload the page." };
  const mark = [...a.versions].reverse().find((m) => m.signature);
  if (!mark?.signature) return { ok: false, why: "Nothing has been signed yet." };
  if (a.sent.length >= MAX_SENDS) return { ok: false, why: `One agreement is emailed at most ${MAX_SENDS} times.` };
  const last = a.sent[a.sent.length - 1] ?? 0;
  if (now - last < 24 * 3_600_000) return { ok: false, why: "The last email about it went less than 24 hours ago." };
  const version = await readVersion(a, mark.n);
  if (!version) return { ok: false, why: "That agreement can't be read right now. Try again in a minute." };
  const w = agreementWords(store.language);
  const said = speechFor(store.language, version.currency);
  const html = signedCopyHtml(store, a, version, mark.signature);
  const outcome = await sendEmailOutcome({
    meter: { by: "store", store, kind: "email" },
    from: fromStore(store),
    to: a.email,
    replyTo: store.email,
    subject: w.copySubject(store.name, version.title).slice(0, 180),
    text: [w.greeting(a.name), "", w.copyLead(mark.signature.name, said.date(mark.signature.at)), "", `--- ${w.textHeading} ---`, version.text, "---", "", w.copyPage, agreementLink(store, a), "", w.footer(store.name)].join("\n"),
    attachments: [{ filename: `signed-${a.id.slice(0, 8)}-v${version.n}.html`, content: Buffer.from(html, "utf8").toString("base64") }],
    idempotencyKey: `nimbus-agree:${a.id}:${a.sent.length}`,
  }).catch(() => "uncertain" as const);
  // Not known: one of its emails (the next one's key moves on), not a copy known to be sent, and said so (UNCONFIRMED).
  await changeAgreement(store, a.id, (current) => (outcome === "refused"
    ? { ...current, failed: NOT_SENT }
    : outcome === "sent"
      ? { ...current, sent: [...current.sent, now], copies: current.copies + 1, failed: "" }
      : { ...current, sent: [...current.sent, now], failed: UNCONFIRMED }), now);
  return outcome === "uncertain" ? { ok: true, sent: false, uncertain: true } : { ok: true, sent: outcome === "sent" };
}
