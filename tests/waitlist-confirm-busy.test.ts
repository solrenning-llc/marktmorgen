/**
 * A waitlist confirmation refused because the store's public requests ran out (WAIT_CONFIRM_UNITS, #4404) never
 * tells the buyer their link expired (review of #4404, Claude 4 cloud AD, LEVE; VR item 2: nothing untrue shown to a
 * customer). The link still works, so the page says so and asks them to press it again later; "This link has
 * expired" is kept for a link that really is gone. The words are said in every language the page speaks, in the same
 * heading and paragraph as every other notice.
 *
 * Synthetic only: the in-memory Redis stand-in, no email sent.
 */
import { readFileSync } from "node:fs";
import { addProduct, claimHandle, ensureListId, ensureStatsId, storeForEmail, storeForHandle } from "@/lib/store";
import { readListing } from "@/lib/catalog";
import { confirmSpot, joinWaitlist, readWaitToken, setSoon } from "@/lib/waitlist";
import { takePublicRequest } from "@/lib/traffic";
import { GIVING_WORDS } from "@/lib/buyer-words/giving";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const sent: string[] = [];

async function main(): Promise<void> {
  redis.clear();
  process.env.RESEND_API_KEY = "re_test_waitlist_only";
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.hostname === "api.resend.com") {
      sent.push(String((JSON.parse(String(init?.body)) as { text?: string }).text ?? ""));
      return new Response(JSON.stringify({ id: "email_1" }));
    }
    return new Response("{}", { status: 404 });
  }) as typeof fetch;
  const owner = "wait-busy-owner@example.com";
  await claimHandle(owner, "waitbusy", "Wait Busy", "");
  await ensureStatsId(owner);
  await ensureListId(owner);
  const made = await addProduct(owner, "The Soon Book", "", "39", null);
  if (!made.ok) throw new Error("no product");
  const store = (await storeForEmail(owner))!;
  const product = (await readListing(store, made.product.id))!;
  await setSoon(store, product.id, true);
  is("(control) a buyer joins", await joinWaitlist({ store, product, email: "wait-busy@example.com", consent: true, ip: "4.4.4.4", origin: "https://marktmorgen.com" }), "sent");
  const token = sent[sent.length - 1].match(/token=([0-9a-f]{48})/)?.[1] ?? "";

  part("A press refused because the store's requests ran out says so, never that the link expired");
  {
    let spent = 0;
    while (spent < 10_000 && (await takePublicRequest(store, "public", Date.now(), 1_000))) spent += 1;
    is("(control) the store's public requests are spent", await takePublicRequest(store, "public", Date.now(), 1), false);
    const grant = await readWaitToken(token);
    const refused = await confirmSpot(token, grant ? await storeForHandle(grant.h) : null);
    is("the press is refused for want of a request, said as busy", refused, { ok: false, reason: "busy" });
    is("(control) the link still works after it", (await readWaitToken(token)) !== null, true);
  }

  part("A link that is gone is still said as expired");
  is("an unknown link is refused with no reason", await confirmSpot("0".repeat(48), store), { ok: false });

  part("The press sends a busy refusal to its own notice, and every language says it truthfully");
  const route = readFileSync("app/api/store/waitlist/confirm/route.ts", "utf8");
  is("the route sends a busy refusal to status=busy, and only a refusal without it to expired", /result\.ok \? "confirmed" : "reason" in result && result\.reason === "busy" \? "busy" : "expired"/.test(route), true);
  for (const [language, words] of Object.entries(GIVING_WORDS)) {
    const busy = words.waitNotices.busy;
    is(`${language}: a busy notice exists, apart from the expired one`, Boolean(busy?.title && busy.body) && busy.title !== words.waitNotices.expired.title && busy.body !== words.waitNotices.expired.body, true);
  }
  is("English says the link still works and to try again later", [GIVING_WORDS.en.waitNotices.busy?.title, GIVING_WORDS.en.waitNotices.busy?.body], ["We could not confirm your spot just now", "Your link still works. Press it again in a little while."]);
  const page = readFileSync("app/[handle]/waitlist/page.tsx", "utf8");
  is("the page shows it as every other notice: the same heading and paragraph", page.includes("const notice = g.waitNotices[status] ?? g.waitNotices.error;"), true);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
