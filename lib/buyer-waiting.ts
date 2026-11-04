/**
 * What a store is waiting on from one buyer, for their orders page
 * (app/[handle]/orders, 639 [GL7](34)): the payment requests sent to them
 * that still take payment, and the proposals and agreements sent to them
 * that still take a signature. Read from this person's own sets in the
 * store (lib/payment-request-store.ts requestsOfPerson, lib/agreement-store.ts
 * agreementsOfPerson): four commands and at most MAX_PER_PERSON records of
 * each, whatever the store keeps, plus one per agreement shown for its text;
 * nothing new is stored. Only what was emailed to this address (an item
 * whose email never went is the creator's to send again, not the buyer's to
 * find), and only what its own page would still act on: paid, withdrawn,
 * expired and signed ones are not shown. Each item's link is the page that
 * was already emailed to them.
 */
import { type Agreement, type AgreementKind, latestOf, statusOf as agreementStatus } from "@/lib/agreement-rules";
import { agreementsOfPerson, readVersion } from "@/lib/agreement-store";
import { type PaymentRequest, statusOf as requestStatus } from "@/lib/payment-request-rules";
import { requestsOfPerson } from "@/lib/payment-request-store";
import type { Store } from "@/lib/store";

/** Items listed of each kind; a store rarely has more open for one person. */
export const WAITING_SHOWN = 10;

export type WaitingRequest = { id: string; total: number; dueDate: string; expiresAt: number };
export type WaitingAgreement = { id: string; kind: AgreementKind; title: string; expiresAt: number };
/**
 * What waits, up to WAITING_SHOWN of each kind; how many there are in all
 * (more than shown when a store has sent many); and whether a list could
 * not be read just now, so the page never says nothing waits when it does not know.
 */
export type Waiting = { requests: WaitingRequest[]; agreements: WaitingAgreement[]; requestsTotal: number; agreementsTotal: number; unread: boolean };

const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/** The open payment requests emailed to this address, soonest due first (undated last), all of them. */
export function openRequestsFor(requests: readonly PaymentRequest[], email: string, now: number): WaitingRequest[] {
  return requests
    .filter((request) => same(request.email, email) && request.sent.length > 0 && requestStatus(request, now) === "open")
    .sort((a, b) => (a.dueDate || "9999-12-31").localeCompare(b.dueDate || "9999-12-31") || a.createdAt - b.createdAt)
    .map((request) => ({ id: request.id, total: request.total, dueDate: request.dueDate, expiresAt: request.expiresAt }));
}

/** The proposals and agreements emailed to this address still waiting for a signature, the first to stop taking one first, all of them. */
export function openAgreementsFor(agreements: readonly Agreement[], email: string, now: number): Agreement[] {
  return agreements
    .filter((agreement) => same(agreement.email, email) && agreement.sent.length > 0 && agreementStatus(agreement, now) === "open")
    .sort((a, b) => a.expiresAt - b.expiresAt);
}

/**
 * Everything waiting on this buyer at this store, WAITING_SHOWN of each kind
 * at most, with how many in all. A list that cannot be read is said to be
 * unread, never guessed.
 */
export async function waitingFor(store: Store, email: string, now = Date.now()): Promise<Waiting> {
  const [requests, agreements] = await Promise.all([requestsOfPerson(store, email).catch(() => null), agreementsOfPerson(store, email).catch(() => null)]);
  const allRequests = openRequestsFor(requests ?? [], email, now);
  const allAgreements = openAgreementsFor(agreements ?? [], email, now);
  let unread = requests === null || agreements === null;
  const titled = await Promise.all(
    allAgreements.slice(0, WAITING_SHOWN).map(async (agreement) => {
      const latest = latestOf(agreement);
      const version = latest ? await readVersion(agreement, latest.n).catch(() => null) : null;
      // An agreement whose text cannot be read is not listed (its page could not show it either), and the page says something could not be read.
      if (!version) unread = true;
      return version ? { id: agreement.id, kind: agreement.kind, title: version.title, expiresAt: agreement.expiresAt } : null;
    }),
  );
  return {
    requests: allRequests.slice(0, WAITING_SHOWN),
    agreements: titled.filter((item): item is WaitingAgreement => item !== null),
    requestsTotal: allRequests.length,
    agreementsTotal: allAgreements.length,
    unread,
  };
}
