import { answerText, type FormDef, type FormResponse } from "@/lib/forms";
import { CRM_ID, MAX_DEAL_NOTE, MAX_DEAL_TITLE } from "@/lib/crm-rules";
import { emailQuestionIds, foldAddress, isAddress, respondentOf } from "@/lib/form-respondent";

/**
 * Reviewable CRM copy, not a marketing subscription or a message. The note
 * never copies an answer that is an address other than the sender's (a
 * friend's, a referrer's, or any when the sender cannot be told), by the rule
 * the erasure of a person's form answers reads (lib/form-respondent.ts): a
 * person is deleted from the CRM by the deals that name them as the contact
 * (lib/crm.ts, forgetCrmPerson), so their address in somebody else's note would
 * stay. The sender's own address is the deal's contact and goes with the deal.
 * When the sender cannot be told, the deal has no contact, so each line that
 * held an address stays as "(address not copied)": the creator can see one was
 * given, never what it was.
 */
export function formDealDraft(form: FormDef, response: FormResponse) {
  // Who sent it, by the one rule the copy and the erasure of a person's data read (lib/form-respondent.ts).
  const email = respondentOf(emailQuestionIds(form), response.answers) ?? "";
  const date = new Date(response.at * 1000);
  const source = "Form: " + form.name + (Number.isFinite(date.getTime()) ? "\nSubmitted: " + date.toISOString() : "");
  const details = form.fields.flatMap(field => {
    const given = response.answers[field.id];
    if (typeof given === "string" && isAddress(foldAddress(given)) && foldAddress(given) !== email) return email ? [] : [field.label + ": (address not copied)"];
    const answer = answerText(field, given);
    return answer ? [field.label + ": " + answer] : [];
  });
  const fullNote = [source, ...details].join("\n");
  return { title: form.name.slice(0, MAX_DEAL_TITLE), email, note: fullNote.slice(0, MAX_DEAL_NOTE), truncated: fullNote.length > MAX_DEAL_NOTE };
}

export type FormDealMatch = { formResponseRef?: string; id: string; title: string; email: string; stage: string };

/** Snapshot matches by contact, not proof that two responses describe the same sale. */
export function matchingFormDeals(email: string, deals: readonly FormDealMatch[]): FormDealMatch[] {
  const address = email.trim().toLowerCase();
  if (!address || !/^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/.test(address)) return [];
  return deals.filter(deal => deal.email.trim().toLowerCase() === address);
}

/** Acknowledgment applies only to this email and this set of existing opportunities. */
export function formDealMatchKey(email: string, matches: readonly FormDealMatch[]): string {
  return matches.length ? JSON.stringify([email.trim().toLowerCase(), matches.map(deal => deal.id).sort()]) : "";
}

/** Accept only a complete acknowledgement for this exact source response. */
export function confirmedFormOpportunity(raw: unknown, ref: string): FormDealMatch | null {
  if (!/^[a-f0-9]{64}$/.test(ref) || !raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  if (value.id !== ref.slice(0, 10) || value.formResponseRef !== ref || typeof value.title !== "string"
    || !value.title.trim() || value.title.length > MAX_DEAL_TITLE || typeof value.email !== "string" || value.email.length > 254
    || (value.email.trim() && !/^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/.test(value.email.trim()))
    || typeof value.stage !== "string" || !CRM_ID.test(value.stage)) return null;
  return { id: ref.slice(0, 10), title: value.title.trim(), email: value.email.trim().toLowerCase(), stage: value.stage, formResponseRef: ref };
}

/** Refreshed server data wins; newly confirmed records fill only missing identities. */
export function mergeFormOpportunities(existing: readonly FormDealMatch[], recorded: readonly FormDealMatch[]): FormDealMatch[] {
  const seen = new Set(existing.map(deal => deal.id));
  return [...existing, ...recorded.filter(deal => { if (seen.has(deal.id)) return false; seen.add(deal.id); return true; })];
}
