/**
 * Claude 2 Pfn2k's LEVE on #5369 (Board #5285 row #2641): the "This order link has expired" notice tells the buyer to
 * ask for a new link on the store's orders page, so the page under it gives that one press, in the store's language;
 * the other notices do not. Synthetic: the in-memory Redis, the page rendered on the server.
 */
import { renderToStaticMarkup } from "react-dom/server";
import DiscordPage from "@/app/[handle]/discord/page";
import { DISCORD_WORDS } from "@/lib/buyer-words/discord";
import { LANGUAGE_CODES } from "@/lib/store-language";
import { claimHandle, ensureStatsId, ensureStoreId, setSubscription } from "@/lib/store";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const OWNER = "discord-link-owner@example.test";

const render = async (status: string) =>
  renderToStaticMarkup(await DiscordPage({ params: Promise.resolve({ handle: "@linkgone" }), searchParams: Promise.resolve({ status }) }));

async function main(): Promise<void> {
  redis.clear();
  await claimHandle(OWNER, "linkgone", "Link Gone Studio", "");
  await ensureStatsId(OWNER);
  await ensureStoreId(OWNER);
  await setSubscription(OWNER, { customerId: "cus_linkgone", subscriptionId: "sub_linkgone", active: true, tier: "creator", period: paidPeriod() });

  part("An expired order link: the page gives the way to a new one");
  const page = await render("link");
  is("the expired-link notice is shown", page.includes(DISCORD_WORDS.en.notices.link.title.replace(/'/g, "&#x27;")), true);
  is("a link to the store's orders page, in the store's words", page.includes(`href="/@linkgone/orders"`) && page.includes(DISCORD_WORDS.en.newOrderLink), true);
  is("drawn as the page's button (at least 44 px tall)", /<a[^>]*href="\/@linkgone\/orders"[^>]*class="btn st-btn/.test(page) || /<a[^>]*class="btn st-btn[^"]*"[^>]*href="\/@linkgone\/orders"/.test(page), true);

  part("Other notices do not offer it");
  for (const status of ["none", "failed", "expired", "declined", "off"]) {
    is(`${status}: no orders-page button`, (await render(status)).includes(`href="/@linkgone/orders"`), false);
  }

  part("Every language has its own words for it");
  for (const code of LANGUAGE_CODES) {
    const words = DISCORD_WORDS[code].newOrderLink;
    is(`${code}: written`, typeof words === "string" && words.trim().length > 0, true);
    if (code !== "en") is(`${code}: not the English`, words !== DISCORD_WORDS.en.newOrderLink, true);
  }
  done();
}

void main();
