/**
 * Sweep app-6 proof: components/next-offer-box.tsx:36-48 tells the buyer the
 * suggestion "won't be suggested again for this order" without reading the
 * server's answer. The route (app/api/store/assistant-next/route.ts:31-33)
 * answers { ok: false } with 429 when the dismissal is rate-limited and with
 * 404 when dismissNextOffer could not keep it (no kept choice, Redis not
 * configured or failing); a dropped connection never reaches it. In each case
 * nothing was kept (lib/next-offer.ts:333-339), so the same offer is shown
 * again on reload, yet the buyer was told it would not be.
 *
 * A check named "DEFECT" passes while the defect is present.
 */
import { NextOfferBox } from "@/components/next-offer-box";
import { nextOfferWords } from "@/lib/buyer-words/next-offer";
import { find, mount, texts } from "./sweep-app6-hooks";
import { done, is, part } from "./check";

const w = nextOfferWords("en");
const props = { handle: "sweepshop", session: "cs_test_sweep0000000000000000", href: "/@sweepshop/p/next", see: w.see, dismiss: w.dismiss, dismissed: w.dismissed, note: "", children: null };

async function press(answer: () => Promise<Response>) {
  const asked: string[] = [];
  globalThis.fetch = (async (url: string) => { asked.push(String(url)); return answer(); }) as typeof fetch;
  const box = await mount(NextOfferBox, props);
  const button = find(box.tree(), (n) => n.type === "button" && texts(n.props?.children).includes(w.dismiss))[0];
  (button.props!.onClick as () => void)();
  await box.settle();
  return { asked, said: texts(box.tree()).join(" ") };
}

const json = (body: unknown, status: number) => async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

async function main() {
  part("Healthy control: the server kept the dismissal (200, ok: true)");
  const kept = await press(json({ ok: true }, 200));
  is("one dismissal sent", kept.asked, ["/api/store/assistant-next"]);
  is("buyer told it will not be suggested again", kept.said, w.dismissed);

  for (const [label, answer] of [
    ["429 { ok: false } (rate limit, route.ts:31)", json({ ok: false }, 429)],
    ["404 { ok: false } (nothing kept, route.ts:32-33)", json({ ok: false }, 404)],
    ["503 non-JSON page", async () => new Response("<html>unavailable</html>", { status: 503 })],
    ["connection dropped", async () => { throw new TypeError("Failed to fetch"); }],
  ] as const) {
    part(`Defect: ${label}`);
    const lost = await press(answer);
    is("DEFECT: buyer still told \"It won't be suggested again for this order.\"", lost.said, w.dismissed);
    is("DEFECT: no error or retry shown", /try again|could not|did not/i.test(lost.said), false);
  }
  done();
}
void main();
