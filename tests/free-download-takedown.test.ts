/**
 * A free copy's emailed link after a takedown (uploads audit A1): the real
 * app/api/store/free/download route, with the real lib/serve-file.ts, hands
 * nothing over once the product was taken down (hidden) or the store switched
 * off (suspended), as the request for a copy already refuses; a store or a
 * listing that cannot be read hands nothing over either (CX-123 rule 24).
 * An ordinary free product is still handed over.
 */
import { POST } from "@/app/api/store/free/download/route";
import { world } from "./free-download-takedown-world";
import { done, is, part } from "./check";

function reset(over: Partial<typeof world> = {}) {
  Object.assign(world, { suspended: "", hidden: false, link: "", storeThrows: false, listingThrows: false, served: [], leads: 0, events: 0, queued: 0 }, over);
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

/** Nothing was handed over and nothing was counted as a sign-up. */
function nothingHanded(label: string) {
  is(`${label}: no file read from storage`, world.served.length, 0);
  is(`${label}: no sign-up recorded`, world.leads, 0);
  is(`${label}: no webhook queued`, world.events, 0);
  is(`${label}: no follow-up queued`, world.queued, 0);
}

(async () => {
  part("an ordinary free product is still handed over");
  reset();
  let answer = await press();
  is("status", answer.status, 200);
  is("file read once", world.served.length, 1);
  is("sign-up recorded", world.leads, 1);

  part("a product taken down by a notice (hidden) is no longer handed over");
  reset({ hidden: true });
  answer = await press();
  is("status", answer.status, 410);
  is("body", await answer.text(), "gone");
  nothingHanded("hidden");

  part("a store switched off by a notice (suspended) hands nothing over");
  reset({ suspended: "2026-11-09T10:00:00.000Z" });
  answer = await press();
  is("status", answer.status, 410);
  is("body", await answer.text(), "gone");
  nothingHanded("suspended");

  part("a taken-down product kept as a link does not redirect");
  reset({ hidden: true, link: "https://example.com/guide" });
  answer = await press();
  is("status", answer.status, 410);
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

  done();
})();
