/**
 * A leaked feed address can be replaced (audit of private podcasts, 9 November 2026, M3).
 *
 * feedToken handed the same token to an address for good, and nothing replaced it: a feed posted on a forum played for
 * anyone while the buyer held the podcast, each episode one of the store's public requests, and neither the buyer nor
 * the creator could stop it short of a refund. Now:
 *
 *   - revokeFeed ends the address's feed (index and grant); the next feed handed to it is a new one;
 *   - replaceFeed ("Get a new feed address") ends the old feed at once and, while the address still holds the podcast,
 *     emails it the page with its new feed; never shows the new address to whoever asked with the old one;
 *   - a feed handed out from a stale read of the index is never brought back: a grant re-written for a token the index
 *     no longer holds is deleted again, so a replaced address stays dead.
 *
 * Synthetic only: the in-memory Redis double and local stand-ins for Stripe and the email service.
 */
import { addProduct, claimHandle, ensureListId, ensureStatsId, ensureStoreId, setPodcastEpisodes, setProductPodcast, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { readListing } from "@/lib/catalog";
import { newPodcastId, savePodcast } from "@/lib/podcast";
import * as access from "@/lib/podcast-access";
import { feedToken, readFeedToken } from "@/lib/podcast-access";
import { paidPeriod } from "./billing-period-fixture";
import { done, is, part } from "./check";
import { store as redis } from "./redis-stub";

const OWNER = "podcast-feed-replace@example.com";
const BUYER = "refunded.replace@example.com";

type Sent = { to: string | string[]; subject: string; text: string };
const emails: Sent[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  if (url.hostname === "api.resend.com") {
    const body = JSON.parse(String(init?.body)) as Sent | Sent[];
    for (const one of Array.isArray(body) ? body : [body]) emails.push(one);
    return new Response(JSON.stringify(Array.isArray(body) ? { data: body.map((_, i) => ({ id: `email_${i}` })) } : { id: "email_1" }));
  }
  if (url.hostname === "api.stripe.com") return new Response(JSON.stringify({ object: "list", data: [], has_more: false }), { status: 200 });
  return new Response("{}", { status: 404 });
}) as typeof fetch;

type Replace = (input: { store: unknown; product: unknown; email: string; base: string; from: string }) => Promise<string>;
type Revoke = (store: unknown, productId: string, email: string) => Promise<boolean>;

async function main(): Promise<void> {
  redis.clear();
  process.env.UPSTASH_REDIS_REST_URL ??= "http://stub";
  process.env.STRIPE_SECRET_KEY = "sk_test_podcast_replace_only";
  process.env.RESEND_API_KEY = "re_test_podcast_replace_only";
  await claimHandle(OWNER, "podfeedreplace", "Pod Feed Replace", "");
  await ensureStatsId(OWNER);
  await ensureStoreId(OWNER);
  await ensureListId(OWNER);
  await setStripeAccount(OWNER, "acct_1PodFeedReplace1", true);
  await setSubscription(OWNER, { customerId: "cus_PodFeedReplace", subscriptionId: "sub_PodFeedReplace", active: true, tier: "creator", period: paidPeriod() });
  const made = await addProduct(OWNER, "Members Radio", "", "19");
  if (!made.ok) throw new Error("no product");
  const id = made.product.id;
  const podcastId = newPodcastId();
  if (!(await setProductPodcast(OWNER, id, { id: podcastId, episodes: 0 })).ok) throw new Error("not a podcast");
  await savePodcast({ id: podcastId, episodes: [{ id: "aaaaaaaaaaa1", title: "One", notes: "", pathname: "vault/0123456789abcdef0123456789abcdef/abcdefghij12/one.mp3", bytes: 1000, contentType: "audio/mpeg", at: 1 }] });
  await setPodcastEpisodes(OWNER, id, 1);
  const store = (await storeForEmail(OWNER))!;
  const product = (await readListing(store, id))!;
  const replaceFeed = (access as Record<string, unknown>).replaceFeed as Replace | undefined;
  const revokeFeed = (access as Record<string, unknown>).revokeFeed as Revoke | undefined;

  part("Replacing a feed that leaked, for an address that holds the podcast (the creator's own, here)");
  is("lib/podcast-access.ts has replaceFeed", typeof replaceFeed, "function");
  is("lib/podcast-access.ts has revokeFeed", typeof revokeFeed, "function");
  const old = (await feedToken(store, id, OWNER))!;
  emails.length = 0;
  const result = replaceFeed ? await replaceFeed({ store, product, email: OWNER, base: "https://marktmorgen.com/@podfeedreplace", from: "Pod <no-reply@example.com>" }) : "missing";
  is("sent", result, "sent");
  is("the old address stops working at once", await readFeedToken(old), null);
  const fresh = await feedToken(store, id, OWNER);
  is("a new address", typeof fresh === "string" && fresh !== old, true);
  is("that opens the same podcast for the same address", (await readFeedToken(fresh ?? ""))?.e, OWNER);
  is("emailed to the address, with the new feed's page", emails.length === 1 && emails[0].text.includes(`?t=${fresh}`), true);
  is("the old address is in no email", emails.every((e) => !e.text.includes(old)), true);

  part("An address that no longer holds it: the old feed ends, and nothing is sent");
  const dead = (await feedToken(store, id, BUYER))!;
  emails.length = 0;
  const ended = replaceFeed ? await replaceFeed({ store, product, email: BUYER, base: "https://marktmorgen.com/@podfeedreplace", from: "Pod <no-reply@example.com>" }) : "missing";
  is("ended", ended, "ended");
  is("the old address is gone", await readFeedToken(dead), null);
  is("no email", emails.length, 0);

  part("An address with no feed");
  const none = replaceFeed ? await replaceFeed({ store, product, email: "nobody.here@example.com", base: "https://marktmorgen.com/@podfeedreplace", from: "Pod <no-reply@example.com>" }) : "missing";
  is("none", none, "none");

  part("A feed handed out from a stale read of the index never brings a replaced address back");
  const before = (await feedToken(store, id, OWNER))!;
  if (revokeFeed) await revokeFeed(store, id, OWNER);
  const after = (await feedToken(store, id, OWNER))!;
  is("revoked, then a new one", typeof after === "string" && after !== before, true);
  // The next read of the index answers the old token, as one made just before the replacement would have.
  const original = redis.pipeline.bind(redis);
  let stale = true;
  redis.pipeline = (async (batch: (string | number)[][]) => {
    if (stale && batch.length === 1 && batch[0][0] === "GET" && String(batch[0][1]).startsWith("nl:pod:by:")) {
      stale = false;
      return [before];
    }
    return original(batch);
  }) as typeof redis.pipeline;
  const handed = await feedToken(store, id, OWNER);
  redis.pipeline = original as typeof redis.pipeline;
  is("the old token is not handed out", handed === before, false);
  is("and its grant is not written back", await readFeedToken(before), null);
  done();
}

void main();
