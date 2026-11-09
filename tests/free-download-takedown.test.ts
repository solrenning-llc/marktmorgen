/**
 * A free copy's emailed link after a takedown (uploads audit A1): the real
 * app/api/store/free/download route, with the real lib/serve-file.ts, hands
 * nothing over once the product was taken down (hidden) or the store switched
 * off (suspended), as the request for a copy already refuses; a store or a
 * listing that cannot be read hands nothing over either (CX-123 rule 24).
 * An ordinary free product is still handed over.
 *
 * Joined with 662 [OF1] (tests/of1-suspended-subpages.test.ts): every refusal
 * is made before a use of the link is spent, and a product taken down answers
 * as a store switched off does on its other pages, 404 "This page is
 * unavailable." (lib/buyer-words/blocks.ts), so the link keeps its uses for
 * when the product or the store is back.
 */
import { readFileSync } from "node:fs";
import { POST } from "@/app/api/store/free/download/route";
import { offeredFree, stillGivenFree } from "@/lib/free-offer";
import { BLOCK_WORDS } from "@/lib/buyer-words/blocks";
import { world } from "./free-download-takedown-world";
import { done, is, part } from "./check";

function reset(over: Partial<typeof world> = {}) {
  Object.assign(world, { suspended: "", hidden: false, link: "", storeThrows: false, listingThrows: false, claimThrows: false, spent: 0, served: [], leads: 0, events: 0, queued: 0 }, over);
}

async function press() {
  const form = new FormData();
  form.set("token", "a".repeat(64));
  const request = new Request("https://marktmorgen.com/api/store/free/download", {
    method: "POST",
    headers: { host: "marktmorgen.com", origin: "https://marktmorgen.com" },
    body: form,
  });
  return POST(request as never);
}

/** Nothing was handed over, nothing was counted as a sign-up, and the link kept every use. */
function nothingHanded(label: string) {
  is(`${label}: no use of the link spent`, world.spent, 0);
  is(`${label}: no file read from storage`, world.served.length, 0);
  is(`${label}: no sign-up recorded`, world.leads, 0);
  is(`${label}: no webhook queued`, world.events, 0);
  is(`${label}: no follow-up queued`, world.queued, 0);
}

(async () => {
  part("an ordinary free product is still handed over");
  reset();
  let answer: Response | null = await press();
  is("status", answer?.status, 200);
  is("file read once", world.served.length, 1);
  is("sign-up recorded", world.leads, 1);
  is("one use of the link spent", world.spent, 1);

  // Assertions changed (rule 23), in the three parts below: status 410 and body freeGone ("gone") became
  // 404 and "This page is unavailable.", the answer the store's other pages give while it is switched off
  // (662 [OF1], tests/of1-suspended-subpages.test.ts), so one rule answers a product taken down and a store
  // switched off. Each is now refused before a use of the link is spent (nothingHanded).
  const unavailable = `${BLOCK_WORDS.en.unavailableTitle}.`;

  part("a product taken down by a notice (hidden) is no longer handed over");
  reset({ hidden: true });
  answer = await press();
  is("status", answer.status, 404);
  is("body", await answer.text(), unavailable);
  nothingHanded("hidden");

  part("a store switched off by a notice (suspended) hands nothing over");
  reset({ suspended: "2026-11-09T10:00:00.000Z" });
  answer = await press();
  is("status", answer.status, 404);
  is("body", await answer.text(), unavailable);
  nothingHanded("suspended");

  part("a taken-down product kept as a link does not redirect");
  reset({ hidden: true, link: "https://example.com/guide" });
  answer = await press();
  is("status", answer.status, 404);
  is("no Location", answer.headers.get("location"), null);
  nothingHanded("hidden link");

  part("a store that cannot be read hands nothing over, and says to try again");
  reset({ storeThrows: true });
  answer = await press().catch(() => null);
  is("status", answer?.status ?? "threw", 503);
  nothingHanded("store unread");

  part("a listing that cannot be read hands nothing over, and says to try again");
  reset({ listingThrows: true });
  answer = await press().catch(() => null);
  is("status", answer?.status ?? "threw", 503);
  nothingHanded("listing unread");

  part("a link that cannot be read hands nothing over, and says to try again");
  reset({ claimThrows: true });
  answer = await press().catch(() => null);
  is("status", answer?.status ?? "threw", 503);
  nothingHanded("link unread");

  part("one condition for the request and the emailed link (lib/free-offer.ts)");
  const free = { priceCents: 0, hidden: false, recurring: null };
  is("free, published, not a subscription", offeredFree(free), true);
  is("hidden", offeredFree({ ...free, hidden: true }), false);
  is("priced", offeredFree({ ...free, priceCents: 100 }), false);
  is("a subscription", offeredFree({ ...free, recurring: "month" as never }), false);
  is("store running", stillGivenFree({ suspended: "" }, free), true);
  is("store switched off", stillGivenFree({ suspended: "2026-11-09T10:00:00.000Z" }, free), false);
  is("store running, product hidden", stillGivenFree({ suspended: "" }, { ...free, hidden: true }), false);
  const canGive = readFileSync("lib/free.ts", "utf8").match(/export function canGiveProduct[\s\S]*?\n}\n/)?.[0] ?? "";
  is("canGiveProduct asks offeredFree", /\bofferedFree\(product\) &&/.test(canGive), true);

  done();
})();
