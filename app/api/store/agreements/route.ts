import type { NextRequest } from "next/server";
import { guardStoreWrite, text } from "@/lib/store-request";
import { ensureStoreId } from "@/lib/store";
import { DRAFT_PROBLEMS, ID_PATTERN, agreementsAllowed, latestOf, readDraft } from "@/lib/agreement-rules";
import { agreementOf, createAgreement, deleteAgreement, readVersion, reviseAgreement, withdrawAgreement } from "@/lib/agreement-store";
import { moneyField } from "@/lib/money";
import { resendSignedCopy, sendAgain, sendAgreementEmail } from "@/lib/agreements";
import { requestOf } from "@/lib/payment-request-store";
import { statusOf as requestStatus } from "@/lib/payment-request-rules";

/**
 * The studio's proposals and agreements (lib/agreement-rules.ts), for a role
 * that may email people for the store ("send": the owner and admins):
 *
 *   { action: "create", kind, email, name, title, body, lines: [{ text, quantity, amount }], payRequest?, consent }
 *   { action: "revise", id, title, body, lines, payRequest? }   a new version, which needs a new signature
 *   { action: "read" | "resend" | "copy" | "withdraw" | "delete", id }
 *
 * Creating or revising keeps it within every count and the data room and
 * emails the link at once, from the store's emails for the month. Answers
 * `{ ok, id?, sent? }` or `{ ok: false, error, message }` with a sentence.
 */
export async function POST(request: NextRequest) {
  const guarded = await guardStoreWrite(request, "send", 40_000);
  if (!guarded.ok) return guarded.response;
  const { body } = guarded;
  let store = guarded.store;
  const refuse = (error: string, message: string, status = 400) => Response.json({ ok: false, error, message }, { status });
  // A payment request attached must be one of this store's, still open.
  const payOk = async (id: string) => {
    if (!id) return true;
    const found = await requestOf(store, id).catch(() => null);
    return Boolean(found && requestStatus(found) === "open");
  };
  try {
    const action = text(body.action, 20);
    if (action === "create") {
      if (!agreementsAllowed(store)) return refuse("closed", "Agreements can be sent while your plan, or free trial, is running.", 409);
      if (!store.sid) store = (await ensureStoreId(guarded.ref)) ?? store;
      const read = readDraft(body, store.currency);
      if (!read.ok) return refuse(read.problem, read.line !== undefined ? `Line ${read.line + 1}: ${DRAFT_PROBLEMS[read.problem]}` : DRAFT_PROBLEMS[read.problem]);
      if (!(await payOk(read.draft.payRequest))) return refuse("pay", DRAFT_PROBLEMS.pay);
      const created = await createAgreement(store, read.draft);
      if (!created.ok) return refuse(created.reason, created.message, created.reason === "unavailable" ? 503 : 409);
      const done = await sendAgreementEmail(store, created.agreement, created.version);
      return Response.json({ ok: true, id: created.agreement.id, sent: done.sent });
    }
    const id = text(body.id, 40);
    if (!ID_PATTERN.test(id)) return refuse("invalid", "That agreement is not one of this store's. Reload the page.");
    if (action === "read") {
      // The latest version's own words, to start a new version from.
      const current = await agreementOf(store, id);
      const latest = current ? latestOf(current) : null;
      const version = current && latest ? await readVersion(current, latest.n) : null;
      if (!version) return refuse("gone", "That agreement can't be read right now. Reload the page.", 404);
      return Response.json({ ok: true, version: { n: version.n, title: version.title, body: version.body, lines: version.lines.map((l) => ({ text: l.text, quantity: String(l.quantity), amount: moneyField(l.cents, version.currency) })), text: version.text, sha256: version.sha256, currency: version.currency } });
    }
    if (action === "revise") {
      if (!agreementsAllowed(store)) return refuse("closed", "Agreements can be sent while your plan, or free trial, is running.", 409);
      const current = await agreementOf(store, id);
      if (!current) return refuse("gone", "That agreement is gone. Reload the page.", 404);
      const read = readDraft(body, store.currency, current);
      if (!read.ok) return refuse(read.problem, read.line !== undefined ? `Line ${read.line + 1}: ${DRAFT_PROBLEMS[read.problem]}` : DRAFT_PROBLEMS[read.problem]);
      if (!(await payOk(read.draft.payRequest))) return refuse("pay", DRAFT_PROBLEMS.pay);
      const changed = await reviseAgreement(store, id, read.draft);
      if (!changed.ok) return refuse(changed.reason, changed.message, changed.reason === "unavailable" ? 503 : 409);
      const done = await sendAgreementEmail(store, changed.agreement, changed.version);
      return Response.json({ ok: true, id, sent: done.sent, version: changed.version.n });
    }
    if (action === "resend") {
      if (!agreementsAllowed(store)) return refuse("closed", "Agreements can be sent while your plan, or free trial, is running.", 409);
      const done = await sendAgain(store, id);
      if (!done.ok) return refuse("not_now", done.why, 409);
      return Response.json({ ok: true, sent: done.sent });
    }
    if (action === "copy") {
      const done = await resendSignedCopy(store, id);
      if (!done.ok) return refuse("not_now", done.why, 409);
      return Response.json({ ok: true, sent: done.sent });
    }
    if (action === "withdraw") {
      const done = await withdrawAgreement(store, id);
      if (done === null) return refuse("gone", "That agreement is gone. Reload the page.", 404);
      if (done === "busy") return refuse("busy", "Someone is signing it right now. Try again in a moment.", 409);
      if (done === "not_open") return refuse("not_open", "Only one waiting for a signature can be withdrawn. A signature already given stays recorded.", 409);
      return Response.json({ ok: true });
    }
    if (action === "delete") {
      const done = await deleteAgreement(store, id);
      if (done === null) return refuse("gone", "That agreement is gone. Reload the page.", 404);
      if (done === "open") return refuse("open", "Withdraw it before deleting it.", 409);
      return Response.json({ ok: true });
    }
    return refuse("invalid", "That is not something this page can do.");
  } catch (error) {
    console.error("an agreement action failed", error);
    return refuse("server_error", "That could not be done right now. Try again in a minute.", 500);
  }
}
