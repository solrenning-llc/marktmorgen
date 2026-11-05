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
import { agreementsOfPerson, readVersion, versionExists } from "@/lib/agreement-store";
import { type PaymentRequest, statusOf as requestStatus } from "@/lib/payment-request-rules";
import { requestsOfPerson } from "@/lib/payment-request-store";
import type { Store } from "@/lib/store";
import type { Currency } from "@/lib/money";

/** Items listed of each kind; a store rarely has more open for one person. */
export const WAITING_SHOWN = 10;

/** An open payment request, with the currency it was made in: what its page and Stripe charge, whatever the store sells in now. */
export type WaitingRequest = { id: string; total: number; currency: Currency; dueDate: string; expiresAt: number };
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
    .map((request) => ({ id: request.id, total: request.total, currency: request.currency, dueDate: request.dueDate, expiresAt: request.expiresAt }));
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
export async function waitingFor(store: Store, email: string, now = Date.now(), withRequests = true): Promise<Waiting> {
  // Requests are not read at all where their page does not take payment (lib/payment-requests.ts, requestsOpen).
  const [requests, agreements] = await Promise.all([withRequests ? requestsOfPerson(store, email).catch(() => null) : Promise.resolve([]), agreementsOfPerson(store, email).catch(() => null)]);
  const allRequests = openRequestsFor(requests ?? [], email, now);
  const allAgreements = openAgreementsFor(agreements ?? [], email, now);
  let unread = requests === null || agreements === null;
  const titled = await Promise.all(
    allAgreements.slice(0, WAITING_SHOWN).map(async (agreement) => {
      const latest = latestOf(agreement);
      // The title is kept in the record's mark of the version: the version's whole text is read only for one kept before that.
      // Its text is only checked to be there (one EXISTS), as its page needs it: one that is gone is not listed and is said as not read.
      if (latest?.title) {
        const there = await versionExists(agreement, latest.n).catch(() => false);
        if (!there) unread = true;
        return there ? { id: agreement.id, kind: agreement.kind, title: latest.title, expiresAt: agreement.expiresAt } : null;
      }
      const version = latest ? await readVersion(agreement, latest.n).catch(() => null) : null;
      // An agreement whose text cannot be read is not listed (its page could not show it either), and the page says something could not be read.
      if (!version) unread = true;
      return version ? { id: agreement.id, kind: agreement.kind, title: version.title, expiresAt: agreement.expiresAt } : null;
    }),
  );
  const shown = titled.filter((item): item is WaitingAgreement => item !== null);
  return {
    requests: allRequests.slice(0, WAITING_SHOWN),
    agreements: shown,
    requestsTotal: allRequests.length,
    // One whose text could not be read is said in "could not be read", not counted in "and N more".
    agreementsTotal: allAgreements.length - (titled.length - shown.length),
    unread,
  };
}

/** A count in words: an exact number up to what one read lists, and "more than" past it, never a total that was not counted (Codex J, #1969). */
function countWords(n: number): string {
  return n > WAITING_SHOWN ? `more than ${WAITING_SHOWN}` : String(n);
}

/**
 * What the library says on a store's card (app/library): how many payment
 * requests and things to sign wait there, in words, and whether some could
 * not be read just now; or "" for nothing waiting. The library is
 * Marktmorgen's own page, so it is in US English.
 */
export function waitingLine(waiting: Pick<Waiting, "requestsTotal" | "agreementsTotal" | "unread">): string {
  const parts: string[] = [];
  const requests = waiting.requestsTotal;
  const toSign = waiting.agreementsTotal;
  if (requests > 0) parts.push(`${countWords(requests)} payment ${requests === 1 ? "request" : "requests"} to pay`);
  if (toSign > 0) parts.push(`${countWords(toSign)} ${toSign === 1 ? "proposal or agreement" : "proposals or agreements"} to sign`);
  const counted = parts.length ? `Waiting for you: ${parts.join(" and ")}.` : "";
  if (!waiting.unread) return counted;
  return counted ? `${counted} Some of it could not be read just now.` : "What this store is waiting on from you could not be read just now.";
}

/** What a store's card says when its requests for the read were used up, so nothing was read (Codex J, #1969). */
export const WAITING_LATER = "What this store is waiting on from you will show here again soon.";
