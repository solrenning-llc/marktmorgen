import { storeForHandle } from "@/lib/store";
import { takePublicRequest } from "@/lib/traffic";
import { taggedLink } from "@/lib/mail-links";
import { SENT_LINK_REQUEST_UNITS, type SentVariant, currentOf, destinationProblem } from "@/lib/sent-link-rules";
import { campaignOf, readSentLinks, sentAddress } from "@/lib/sent-links";

type Params = { params: Promise<{ handle: string; id: string; link: string }> };

const LINK = /^(\d{1,2})([xab])$/;

/**
 * A link in a one-off email (lib/sent-links.ts, 124 [F2-EDIT-SENT-LINKS]):
 * sends the reader to the address the email was sent with, or to where the
 * creator has since sent that link, under lib/sent-link-rules.ts.
 *
 * Never an open redirect: the address it may lead to is the one signed into
 * the link when the email went out, for this store, email, link and subject
 * line, or a change kept for that email and allowed by the rules. Anything
 * else is refused and leads nowhere.
 *
 * Nothing about the reader or the click is written: no open, no click count.
 * One of the store's public requests is counted before the change is read
 * (one read). Whatever cannot be read (the store, its count, the change)
 * leads to the address the email was sent with.
 */
export async function GET(request: Request, { params }: Params) {
  const { handle, id, link } = await params;
  const query = new URL(request.url).searchParams;
  const parsed = LINK.exec(typeof link === "string" ? link : "");
  const sent = parsed ? sentAddress(String(handle ?? ""), String(id ?? ""), Number(parsed[1]), parsed[2] as SentVariant, query.get("u") ?? "", query.get("s") ?? "") : null;
  if (!parsed || !sent) {
    return new Response("This link could not be read. Open the address written in the email instead.", { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });
  }
  const n = Number(parsed[1]);
  const to = await whereItGoes(handle, id, n, parsed[2] as SentVariant, sent);
  return new Response(null, { status: 302, headers: { Location: to, "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } });
}

async function whereItGoes(handle: string, id: string, n: number, variant: SentVariant, sent: string): Promise<string> {
  try {
    const store = await storeForHandle(handle);
    if (!store || !store.listId) return sent;
    if (!(await takePublicRequest(store, "public", Date.now(), SENT_LINK_REQUEST_UNITS))) return sent;
    const kept = await readSentLinks(id);
    if (!kept || kept.l !== store.listId || kept.exp <= Math.floor(Date.now() / 1000)) return sent;
    const to = currentOf(kept.changes, n);
    if (!to || destinationProblem(to, sent, store)) return sent;
    return taggedLink(to, store, { medium: "broadcast", campaign: campaignOf(id, variant) });
  } catch {
    return sent;
  }
}
