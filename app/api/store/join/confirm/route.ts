import { type NextRequest, after } from "next/server";
import { originFrom } from "@/lib/request-origin";
import { storeForHandle } from "@/lib/store";
import { fromAnotherSite, limited } from "@/lib/request-guard";
import { JOIN_TOKEN, confirmJoin, readJoinToken } from "@/lib/store-join";
import { enroll } from "@/lib/flows";
import { queuePerson } from "@/lib/email-sync";
import { allowedBy, newLeadId, sendServerLead, sendsFromServer } from "@/lib/ad-events";
import { emitEvent } from "@/lib/webhooks";
import { recordLead } from "@/lib/affiliate-leads";
import { countConfirmedLead } from "@/lib/path-lead";

/** The button on the page an emailed sign-up link opens: the address joins the creator's list. */
export async function POST(request: NextRequest) {
  const origin = originFrom(request);
  if (fromAnotherSite(request)) return new Response("forbidden", { status: 403 });
  let token = "";
  try {
    const form = await (await limited(request, 1_000)).formData();
    token = String(form.get("token") ?? "").slice(0, 60);
  } catch {
    return new Response("Bad request", { status: 400 });
  }
  const grant = JOIN_TOKEN.test(token) ? await readJoinToken(token) : null;
  const store = grant ? await storeForHandle(grant.h) : null;
  if (!grant || !store) return new Response(null, { status: 303, headers: { Location: grant ? `${origin}/@${grant.h}/join?status=expired` : `${origin}/`, "Cache-Control": "no-store" } });
  let status = "error";
  let lead = "";
  try {
    const result = await confirmJoin(token, store);
    status = result.ok ? "joined" : result.reason;
    if (result.ok) {
      // The creator's welcome sequence, when they have one for people who join,
      // and their own email platform, when they connected one (lib/email-sync.ts).
      await enroll(store, result.grant.e, { joined: result.added.joined });
      // A lead for Marktmorgen Path when the link makes the address newly mailable on the list; the address counts
      // once for the store, two presses at once included (lib/path-lead.ts; 13 [D10]). An unknown answer is logged.
      if (result.added.joined) await countConfirmedLead(store.statsId, result.grant.e).catch((error) => console.error("counting a confirmed lead failed", error));
      // A sign-up an affiliate brought, where the store pays per sign-up: credited now that it is confirmed,
      // and only for an address new to the list (lib/affiliate-leads.ts).
      if (result.grant.a && result.added.joined) {
        await recordLead(store, { aff: result.grant.a, kind: "signup", email: result.grant.e, count: true });
      }
      // Asked from one of the store's forms: a sequence that starts with that form starts now, on confirming.
      if (result.grant.f) await enroll(store, result.grant.e, { joined: false, form: result.grant.f, formOutcome: result.grant.r ?? "" });
      // Joining the list, as a lead to the creator's ad platforms, with the visitor's yes (lib/ad-events.ts).
      if (sendsFromServer(store) && allowedBy(request, store)) {
        const id = newLeadId();
        lead = id;
        after(() => sendServerLead(store, request, { id, email: result.grant.e, product: "email-list" }).catch((error) => console.error("sending a lead failed", error)));
      }
      // The creator's webhooks hear of it once, however often the button is pressed.
      const grant = result.grant;
      after(() =>
        emitEvent(store, "list.joined", `join|${grant.e}|${grant.at}`, {
          email: grant.e,
          // The second box: they allowed their link use in sequences to be seen (lib/mail-clicks.ts).
          allowed_link_tracking: grant.k === true,
          form: grant.f ?? null,
          // The creator's own site it was asked from, through the checkout script (lib/embed-sites.ts).
          site: grant.w ?? null,
          requested_at: grant.at || null,
        }).catch((error) => console.error("queueing the list.joined webhook failed", error)),
      );
      const at = Date.now();
      after(() =>
        queuePerson(store, { source: "free", email: result.grant.e, products: [], consent: true, seed: `join|${result.grant.e}|${result.grant.at}`, at }).catch((error) =>
          console.error("sending a sign-up to an email platform failed", error),
        ),
      );
    }
  } catch (error) {
    console.error("confirming a sign-up failed", error);
  }
  return new Response(null, { status: 303, headers: { Location: `${origin}/@${store.handle}/join?status=${status}${lead ? `&e=${lead}` : ""}`, "Cache-Control": "no-store" } });
}
