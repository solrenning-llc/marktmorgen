import { type NextRequest, after } from "next/server";
import { isFree, storeForHandle } from "@/lib/store";
import { recordLead, spendClaim } from "@/lib/free";
import { recordLead as recordAffiliateLead } from "@/lib/affiliate-leads";
import { scheduleReminder } from "@/lib/welcome-offer-send";
import { enroll } from "@/lib/flows";
import { emitEvent } from "@/lib/webhooks";
import { queuePerson } from "@/lib/email-sync";
import { plain, serveFile } from "@/lib/serve-file";
import { fromAnotherSite, limited } from "@/lib/request-guard";
import { readListing } from "@/lib/catalog";
import { givingWords } from "@/lib/buyer-words/giving";

/**
 * Hands over a free copy, from the link that was emailed.
 *
 * Only a POST opens it. Mail providers and security scanners open every link
 * in an email to look at it, and a GET that handed over the file would put
 * addresses on a creator's list that no person ever confirmed. The emailed
 * link lands on a page with a button; the button is this.
 *
 * The address joins the list here, before the file is sent, because this is
 * the moment it is proved: somebody holding that inbox pressed the button.
 */
export async function POST(request: NextRequest) {
  // Refused before anything else is read: another site, by Origin or by
  // Sec-Fetch-Site (lib/request-guard.ts).
  if (fromAnotherSite(request)) return plain(403, "forbidden");

  let token = "";
  try {
    const value = (await (await limited(request, 8_000)).formData()).get("token");
    token = typeof value === "string" ? value.slice(0, 100) : "";
  } catch {
    return plain(400, "Bad request");
  }

  // A use count that could not be read hands nothing over, and says so (CX-123 rule 24).
  const used = await spendClaim(token).catch((error: unknown) => {
    console.error("counting a free copy's link failed", error);
    return null;
  });
  if (!used) return plain(503, "This link could not be checked just now. Try again in a moment.");
  if (!used.ok) {
    return used.reason === "spent"
      ? plain(429, "This link has been used as many times as it can be. Ask the store for a new copy.")
      : plain(410, "This link has expired. Ask the store for a new copy.");
  }
  const { claim } = used;

  const store = await storeForHandle(claim.h);
  if (!store) return plain(404, "This store is not here anymore.");

  // Looked up again rather than trusted from the claim: a product the creator
  // has since removed, or started charging for, is not handed out for free
  // on the strength of an old email.
  const product = await readListing(store, claim.p);
  const g = givingWords(store.language);
  if (!product || !isFree(product)) {
    return plain(410, g.freeGone);
  }
  if (!product.file && !product.link) {
    return plain(404, g.freeNothing);
  }

  const listed = await recordLead(store, claim, product.title);
  // Sequences start only for someone who agreed to hear from the creator,
  // now or before; enroll checks that.
  if (listed) await enroll(store, claim.e, { joined: listed.joined, productId: claim.p });
  // Claimed through an affiliate's link, where the store pays per free product claimed: credited now that
  // the address is proved, the first time it got this product, and once per person (lib/affiliate-leads.ts).
  if (claim.a && listed?.gotProduct) {
    await recordAffiliateLead(store, { aff: claim.a, kind: "free", email: claim.e, ref: product.id, title: product.title });
  }
  // The creator's webhooks hear of it once per request, however many times
  // the same link is pressed.
  await emitEvent(store, "lead.captured", `${claim.e}|${claim.p}|${claim.at}`, {
    email: claim.e,
    agreed_to_emails: claim.c,
    product: { id: product.id, title: product.title },
    requested_at: claim.at || null,
  }).catch((error) => console.error("queueing the lead.captured webhook failed", error));
  // The creator's own email platform, when they connected one and take free
  // sign-ups there: only someone who ticked the box is sent (lib/email-sync.ts).
  // After the file is on its way, so it never waits on another company.
  // The sign-up happens now, when the address is confirmed.
  const confirmedAt = Date.now();
  // The welcome offer's one reminder, now that the address is confirmed and only if they agreed (lib/welcome-offer-send.ts).
  after(() => scheduleReminder(store, claim, token).then(() => undefined).catch((error) => console.error("setting the welcome offer reminder failed", error)));
  after(() =>
    queuePerson(store, {
      source: "free",
      email: claim.e,
      products: [{ id: product.id, title: product.title }],
      consent: claim.c,
      seed: `${claim.e}|${claim.p}|${claim.at}`,
      at: confirmedAt,
    }).catch((error) => console.error("sending a sign-up to an email platform failed", error)),
  );

  if (product.link) {
    return new Response(null, {
      status: 303,
      headers: { Location: product.link, "Cache-Control": "no-store" },
    });
  }
  return product.file
    ? serveFile(product.file, { paid: false })
    : plain(404, g.freeNothing);
}
