/**
 * What a store is waiting on from one buyer, for their orders page
 * (app/[handle]/orders, 639 [GL7](34)): the payment requests sent to them
 * that still take payment, and the proposals and agreements sent to them
 * that still take a signature. Read from the store's own lists
 * (lib/payment-request-store.ts, lib/agreement-store.ts), each already
 * bounded by what the store keeps; nothing new is stored. Only what was sent
 * to this address, and only what its own page would still act on: paid,
 * withdrawn, expired and signed ones are not shown. Each item's link is the
 * page that was already emailed to them.
 */
import { type Agreement, type AgreementKind, latestOf, statusOf as agreementStatus } from "@/lib/agreement-rules";
import { listAgreements, readVersion } from "@/lib/agreement-store";
import { type PaymentRequest, statusOf as requestStatus } from "@/lib/payment-request-rules";
import { listRequests } from "@/lib/payment-request-store";
import type { Store } from "@/lib/store";

/** Items listed of each kind; a store rarely has more open for one person. */
export const WAITING_SHOWN = 10;

export type WaitingRequest = { id: string; total: number; dueDate: string; expiresAt: number };
export type WaitingAgreement = { id: string; kind: AgreementKind; title: string; expiresAt: number };
export type Waiting = { requests: WaitingRequest[]; agreements: WaitingAgreement[] };

const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/** The open payment requests sent to this address, soonest due first (undated last). */
export function openRequestsFor(requests: readonly PaymentRequest[], email: string, now: number): WaitingRequest[] {
  return requests
    .filter((request) => same(request.email, email) && requestStatus(request, now) === "open")
    .sort((a, b) => (a.dueDate || "9999-12-31").localeCompare(b.dueDate || "9999-12-31") || a.createdAt - b.createdAt)
    .slice(0, WAITING_SHOWN)
    .map((request) => ({ id: request.id, total: request.total, dueDate: request.dueDate, expiresAt: request.expiresAt }));
}

/** The proposals and agreements sent to this address still waiting for a signature, the first to stop taking one first. */
export function openAgreementsFor(agreements: readonly Agreement[], email: string, now: number): Agreement[] {
  return agreements
    .filter((agreement) => same(agreement.email, email) && agreementStatus(agreement, now) === "open")
    .sort((a, b) => a.expiresAt - b.expiresAt)
    .slice(0, WAITING_SHOWN);
}

/**
 * Everything waiting on this buyer at this store. A list that cannot be read
 * is left out, never guessed: the page says so only through what it shows.
 */
export async function waitingFor(store: Store, email: string, now = Date.now()): Promise<Waiting> {
  const [requests, agreements] = await Promise.all([listRequests(store, now).catch(() => null), listAgreements(store).catch(() => null)]);
  const open = openAgreementsFor(agreements ?? [], email, now);
  const titled = await Promise.all(
    open.map(async (agreement) => {
      const latest = latestOf(agreement);
      const version = latest ? await readVersion(agreement, latest.n).catch(() => null) : null;
      // An agreement whose text cannot be read is not listed: its page could not show it either.
      return version ? { id: agreement.id, kind: agreement.kind, title: version.title, expiresAt: agreement.expiresAt } : null;
    }),
  );
  return { requests: openRequestsFor(requests ?? [], email, now), agreements: titled.filter((item): item is WaitingAgreement => item !== null) };
}

/**
 * What the library says on a store's card (app/library): how many payment
 * requests and things to sign wait there, in words, or "" for none. The
 * library is Marktmorgen's own page, so it is in US English.
 */
export function waitingLine(waiting: Waiting): string {
  const parts: string[] = [];
  const requests = waiting.requests.length;
  const toSign = waiting.agreements.length;
  if (requests) parts.push(`${requests} payment ${requests === 1 ? "request" : "requests"} to pay`);
  if (toSign) parts.push(`${toSign} ${toSign === 1 ? "proposal or agreement" : "proposals or agreements"} to sign`);
  return parts.length ? `Waiting for you: ${parts.join(" and ")}.` : "";
}
