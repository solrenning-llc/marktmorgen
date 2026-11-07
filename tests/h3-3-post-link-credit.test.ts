/**
 * 278 [H3-3] unit 1: how a sale is counted for the link of each short video
 * (lib/post-link-credit.ts). The studio, under the short links, and the help
 * answer say it in plain words, and what they say is what the checkout does
 * (lib/visit-channel.ts, proxy.ts):
 *
 *   - a sale counts for one link at most: the page the buyer paid on, if a
 *     link opened it; otherwise the last place they came from within the
 *     store's own window (7, 30, 60 or 90 days);
 *   - where visits are not remembered (the law asks first, the country is
 *     unknown, or Global Privacy Control), only the page they paid on;
 *   - a window that is not one of the four is never shown as a number.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { POST_LINK_UNREMEMBERED, postLinkCredit } from "@/lib/post-link-credit";
import { ATTRIBUTION_DAYS } from "@/lib/attribution-rules";
import { channelForSale, nextChannelCookie, readChannelCookie } from "@/lib/visit-channel";
import { needsConsent } from "@/lib/pixels";
import { HELP_SECTIONS } from "@/lib/help-content";
import { done, is, part } from "./check";

const root = process.cwd();
const source = (file: string) => readFileSync(join(root, file), "utf8");

function main(): void {
  part("The sentence names the store's own window");
  for (const days of ATTRIBUTION_DAYS) {
    is(`${days} days is said as it is`, postLinkCredit(days).includes(`in the ${days} days before buying`), true);
  }
  for (const odd of [0, 45, Number.NaN, "30", undefined, null, -30, 30.5]) {
    const said = postLinkCredit(odd as never);
    is(`a window of ${String(odd)} is never shown as a number`, /\d/.test(said), false);
    is(`a window of ${String(odd)} still says how a sale counts`, said.includes("counts for one link at most"), true);
  }
  is("one link at most, the page paid on first", postLinkCredit(30).startsWith("A sale counts for one link at most. If the buyer pays on the page a link opened, it counts for that link."), true);
  is("no promise words", /\b(every|exactly|guarantee|always|all)\b/i.test(postLinkCredit(30) + POST_LINK_UNREMEMBERED), false);

  part("What the sentence says is what the checkout does");
  const t0 = 1_800_000_000;
  const day = 86_400;
  const linkA = { source: "tiktok", medium: "post", campaign: "october-reel" };
  const linkB = { source: "instagram", medium: "post", campaign: "november-reel" };
  const afterA = nextChannelCookie(undefined, linkA, t0);
  const afterB = nextChannelCookie(afterA, linkB, t0 + day);
  const noTags = { source: "", medium: "", campaign: "" };
  is("paid on the page link A opened: link A", channelForSale(linkA, readChannelCookie(afterB, t0 + 2 * day, 30)).campaign, "october-reel");
  is("paid on an untagged page: the last link used", channelForSale(noTags, readChannelCookie(afterB, t0 + 2 * day, 30)).campaign, "november-reel");
  is("past the window: no link", channelForSale(noTags, readChannelCookie(afterB, t0 + day + 8 * day, 7)).campaign, "");
  is("inside a longer window: still the last link", channelForSale(noTags, readChannelCookie(afterB, t0 + day + 8 * day, 30)).campaign, "november-reel");
  is("nothing remembered: only the page paid on", channelForSale(noTags, null).campaign, "");

  part("Where visits are not remembered");
  is("the law asks first, or the country is unknown", [needsConsent("FR"), needsConsent("GB"), needsConsent("CH"), needsConsent("BR"), needsConsent(null), needsConsent("US")], [true, true, true, true, true, false]);
  for (const words of ["the EU", "the UK", "Switzerland", "Brazil", "country is not known", "Global Privacy Control", "only if the buyer pays on the page that link opened"]) {
    is(`the note names ${words}`, POST_LINK_UNREMEMBERED.includes(words), true);
  }
  const proxy = source("proxy.ts");
  const withChannel = proxy.slice(proxy.indexOf("function withChannel("), proxy.indexOf("function withChannel(") + 600);
  is("the proxy skips the visit cookie on consent countries and GPC", [withChannel.includes("needsConsent("), withChannel.includes('"sec-gpc"')], [true, true]);

  part("Said where the creator makes the links");
  const studio = source("app/studio/page.tsx");
  const links = studio.indexOf("<ShortLinks");
  const said = studio.indexOf("postLinkCredit(store.attributionDays)");
  is("the studio says it right under the short links", links > 0 && said > links && said - links < 1600, true);
  is("the studio says the unremembered case too", studio.slice(said, said + 400).includes("POST_LINK_UNREMEMBERED"), true);
  is("the studio reads nothing new for it", studio.slice(links, said).includes("await ") && !studio.slice(said, said + 400).includes("await "), true);
  const answer = HELP_SECTIONS.flatMap((s) => s.items).find((i) => i.q === "Can I make a short link for a post?");
  const text = (answer?.a ?? []).join(" ");
  is("the help answer says one link at most", text.includes("A sale counts for one link at most"), true);
  is("the help answer names the window choices", text.includes("7, 30, 60 or 90 days"), true);
  is("the help answer names the unremembered case", text.includes("Global Privacy Control"), true);

  done();
}

main();
