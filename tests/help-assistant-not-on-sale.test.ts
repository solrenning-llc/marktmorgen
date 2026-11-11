/**
 * The help center answers "Can the Store assistant suggest one next product
 * after a purchase?" and "...send one reminder after a checkout left unpaid?".
 * Both need a paid add-on window (nextOfferShown reads assistantWindow; the
 * reminder the same), and the add-on cannot be bought while ASSISTANT_ON_SALE
 * is false. Each answer is reached on its own by its anchor (answerId), so each
 * says it is not on sale yet, like the chat answer just above them, and none
 * starts with "Yes" (audit R33, finding 3).
 */
import { HELP_SECTIONS, answerId } from "@/lib/help-content";
import { ASSISTANT_ON_SALE } from "@/lib/opening";
import { nextOfferShown } from "@/lib/next-offer";
import type { Store } from "@/lib/store";
import { isRedisConfigured } from "@/lib/redis";
import { assistantWindow } from "@/lib/store-assistant-rules";
import { done, is, part } from "./check";

function main(): void {
  const items = HELP_SECTIONS.flatMap((s) => s.items);
  const find = (start: string) => items.find((i) => i.q.startsWith(start));
  const chat = find("Can an AI answer my buyers' questions at any hour?");
  const next = find("Can the Store assistant suggest one next product");
  const remind = find("Can the Store assistant send one reminder");

  part("Control");
  is("the add-on is not on sale (lib/opening.ts)", ASSISTANT_ON_SALE, false);
  is("the chat answer says so", (chat?.a ?? []).join(" ").includes("It is not on sale yet"), true);
  // A store with the switch on and no paid add-on window: every store today.
  const store = { handle: "ha", email: "creator@example.com", statsId: "0123456789abcdef0123456789abcdef", stripeAccountId: "acct_help_assistant", suspended: false, nextOffer: { on: true }, assistantPlan: null } as unknown as Store;
  is("every other condition holds (Redis set, stats id, Stripe, not suspended)", isRedisConfigured(), true);
  is("no paid add-on window", assistantWindow(null, Date.now() / 1000), null);
  is("with no paid add-on, the next product is never shown", nextOfferShown(store), false);

  part("Each answer says the add-on is not on sale yet");
  for (const item of [next, remind]) {
    const a = (item?.a ?? []).join(" ");
    is(`"${item?.q}" is found (/help#${answerId(item?.q ?? "")})`, Boolean(item), true);
    is(`"${item?.q}" says the add-on is not on sale`, /not on sale yet/.test(a), true);
    is(`"${item?.q}" does not start with "Yes"`, a.startsWith("Yes"), false);
  }
}

main();
done();
