import { type NextRequest, after } from "next/server";
import { noticeCreator } from "@/lib/account-notice";
import { setDomain, storeForEmail } from "@/lib/store";
import { guardStoreWrite, text } from "@/lib/store-request";
import {
  canUseDomain,
  connectDomain,
  disconnectDomain,
  domainStatus,
  isDomainsConfigured,
  verifyDomain,
} from "@/lib/domains";
import { proveDomain } from "@/lib/domain-proof";
import { UnknownReplyError } from "@/lib/redis-reply";

/**
 * The store's own domain, from the studio:
 *
 *   { action: "connect", name }   adds it, and answers with the records to add
 *   { action: "check" }           looks again, after the creator added them
 *   { action: "remove" }          takes it off; the marktmorgen.com address stays
 *
 * Only the signed-in creator's own store is touched: nothing in the request
 * names a store.
 */
export async function POST(request: NextRequest) {
  const guarded = await guardStoreWrite(request, "settings", 2_000);
  if (!guarded.ok) return guarded.response;
  const { ref, body } = guarded;
  const action = text(body.action, 20);
  const fail = (error: string, status = 400) => Response.json({ ok: false, error }, { status });

  try {
    const store = await storeForEmail(ref);
    if (!store) return fail("none");

    if (action === "remove") {
      if (!store.domain) return Response.json({ ok: true });
      const removed = await disconnectDomain(store.domain.name, [store.handle, ...store.previousHandles]);
      if (removed === "unavailable") return fail("unavailable", 502);
      if (removed === "unfinished") {
        // Vercel has already dropped it, so it no longer serves the store: it is not said to be live any more (emails,
        // the sitemap and affiliate links read liveAt), and it stays on the store so the next press finishes it.
        if (store.domain.liveAt) await setDomain(ref, { ...store.domain, liveAt: "" });
        return fail("unfinished", 502);
      }
      await setDomain(ref, null);
      const name = store.domain.name;
      after(() => noticeCreator(store, { kind: "domain-removed", name }));
      return Response.json({ ok: true });
    }

    if (!canUseDomain(store)) return fail("plan", 403);
    if (!isDomainsConfigured()) return fail("unavailable", 503);

    if (action === "connect") {
      const result = await connectDomain(store, text(body.name, 300));
      if (!result.ok) return fail(result.reason);
      const now = new Date().toISOString();
      await setDomain(ref, { name: result.name, addedAt: now, liveAt: "" });
      // A domain decides where buyers land; the creator hears of every one.
      after(() => noticeCreator(store, { kind: "domain-added", name: result.name }));
      const status = await domainStatus(result.name, store);
      return Response.json({ ok: true, status });
    }

    if (action === "check") {
      if (!store.domain) return fail("none");
      // Our own proof first: the record that says the domain is this store's.
      const proof = await proveDomain(store, store.domain.name);
      if (proof === "taken") return fail("taken", 409);
      let status = await domainStatus(store.domain.name, store);
      // A domain in use elsewhere at Vercel: ask Vercel to look at its TXT record now.
      if (status && !status.live && status.records.some((r) => r.type === "TXT" && !r.name.startsWith("_marktmorgen"))) {
        await verifyDomain(store.domain.name);
        status = await domainStatus(store.domain.name, store);
      }
      if (!status) return fail("unavailable", 502);
      if (status.live && !store.domain.liveAt) {
        await setDomain(ref, { ...store.domain, liveAt: new Date().toISOString() });
      } else if (!status.live && store.domain.liveAt) {
        await setDomain(ref, { ...store.domain, liveAt: "" });
      }
      return Response.json({ ok: true, status });
    }

    return fail("invalid");
  } catch (error) {
    // Who holds a domain could not be read (CX-123 rule 24): nothing was sent to Vercel or deleted on it, so the
    // creator hears the honest "not answering just now, nothing was changed, try again".
    if (error instanceof UnknownReplyError) return fail("unavailable", 503);
    console.error("a domain action failed", error);
    return fail("server_error", 500);
  }
}
