/**
 * Only a button's link can change after an email went out (124 [F2-EDIT-SENT-LINKS] unit 3a, redone over main's
 * implementation from #3034; coordinator's decision of 15 Nov 2026 on #3715). A link written in the text shows its own
 * address as its words: changed after sending, the words would say one address while the link goes to another, which
 * is what mail filters take for phishing and what would mislead the reader. So:
 *   - linksOf keeps its numbering (emails already sent are signed with it), and changeableLinks says which of them
 *     are buttons;
 *   - changeLink refuses a link that is not a button, with words that say why;
 *   - a new email sends only its buttons through the signed redirect; a link in the text goes straight to the
 *     address its words show (tagged as before).
 * Synthetic store, no network.
 */
import { claimHandle, ensureListId, ensureStatsId, setMailSettings, setSubscription, storeForEmail } from "@/lib/store";
import { SITE_URL } from "@/lib/site-url";
import { changeableLinks, linksOf } from "@/lib/sent-link-rules";
import { changeLink } from "@/lib/sent-links";
import { render } from "@/lib/mail";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";

const OWNER = "buttons@example.com";

async function main(): Promise<void> {
  redis.clear();
  const made = await claimHandle(OWNER, "harbor", "Harbor Kitchen", "");
  if (!made.ok) throw new Error("no store");
  await ensureStatsId(OWNER);
  await ensureListId(OWNER);
  await setSubscription(OWNER, { customerId: "cus_Buttons001", subscriptionId: "sub_Buttons001", active: true, tier: "pro", period: paidPeriod() });
  await setMailSettings(OWNER, { fromName: "Harbor Kitchen", address: "1 Main St, Portland, OR 97201" });
  const store = (await storeForEmail(OWNER))!;
  const home = `${SITE_URL}/@harbor`;
  const body = [`Our new plan: ${home}/p/plan.`, "Watch the recipe: https://youtube.com/watch?v=1", "[Join the call](https://zoom.us/j/1)"].join("\n\n");

  part("Which links can change: the buttons only, in linksOf's own numbering");
  is("linksOf keeps every link, in the order it always had", linksOf(body), [`${home}/p/plan`, "https://youtube.com/watch?v=1", "https://zoom.us/j/1"]);
  is("only the button can change", changeableLinks(body), [false, false, true]);
  is("an address both in the text and on a button: the button makes it changeable", changeableLinks(["See https://zoom.us/j/1", "[Join](https://zoom.us/j/1)"].join("\n\n")), [true]);

  part("A link written in the text is never changed after sending");
  const email = { id: "a".repeat(24), listId: store.listId!, links: true, sent: 2, body } as Parameters<typeof changeLink>[1];
  const text = await changeLink(store, email, 1, "https://youtube.com/watch?v=2");
  is("refused, with words that say why", [text.ok, !text.ok && text.reason, !text.ok && /written in the text|its own address/i.test(text.message)], [false, "text", true]);
  const button = await changeLink(store, email, 2, "https://zoom.us/j/2");
  is("control: the button's link changes", button.ok, true);

  part("A new email: only its buttons go through the redirect");
  const via = (href: string, tagged: string) => `${SITE_URL}/go/harbor/${"a".repeat(24)}/${linksOf(body).indexOf(href)}x?u=${encodeURIComponent(tagged)}`;
  const html = render(store, "News", body, "tok", undefined, { medium: "broadcast", campaign: `b-${"a".repeat(24)}`, via }).html;
  const box = html.split('<div style="padding:20px 8px 0')[0];
  const hrefs = [...box.matchAll(/<a href="([^"]+)"/g)].map((m) => m[1].replace(/&amp;/g, "&"));
  is("three links drawn", hrefs.length, 3);
  is("the text's links go straight to the address their words show", [hrefs[0].includes("/go/"), hrefs[1].includes("/go/"), hrefs[1].startsWith("https://youtube.com/watch?v=1")], [false, false, true]);
  is("the button goes through the redirect", hrefs[2].startsWith(`${SITE_URL}/go/harbor/`), true);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
