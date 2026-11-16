/**
 * Claude 6 sweep of components/ (CX-123 rule 24, client side): the "No
 * thanks" on the next product after a purchase, components/next-offer-box.tsx.
 *
 * The buyer's no is sent to /api/store/assistant-next, which keeps it on the
 * order (lib/next-offer.ts, dismissNextOffer) so "neither the page nor the
 * email shows it again". The box never reads the answer: a dropped connection,
 * a 429 or a `{ ok: false }` all end on the same words as a kept no, "Okay. It
 * won't be suggested again for this order." Nothing was kept, so the page
 * shows it again when reloaded and the order's email can still carry it.
 *
 * The checks below say what an honest box does: only a kept no is confirmed.
 * They fail on the current code.
 */
import { readFileSync } from "node:fs";
import { compile, cutBlock, fetchAnswering, recorder } from "./client-handler";
import { NEXT_OFFER_WORDS } from "@/lib/buyer-words/next-offer";
import { done, is, part } from "./check";

const FILE = "components/next-offer-box.tsx";
const make = compile<() => Promise<void>>(cutBlock(FILE, "async function hide() {"), ["fetch", "setState", "handle", "session"], "hide");

async function dismiss(answer: typeof fetch) {
  const state = recorder<string>();
  await make({ fetch: answer, setState: state.set, handle: "synthetic-store", session: "cs_test_synthetic" })();
  return state.last;
}

async function main() {
  part("The words shown once the box is gone");
  is("they say the no was kept", NEXT_OFFER_WORDS.en.dismissed, "Okay. It won't be suggested again for this order.");
  is("and the box shows them on its 'gone' state", readFileSync(FILE, "utf8").includes('if (state === "gone") {'), true);

  part("A no the server kept (control)");
  is("the box goes, with those words", await dismiss(fetchAnswering({ ok: true })), "gone");

  for (const [what, answer] of [
    ["no connection", fetchAnswering(new TypeError("Failed to fetch"))],
    ["too many requests", fetchAnswering({ ok: false }, 429)],
    ["an error page that is not JSON", fetchAnswering("<html>502</html>", 502)],
  ] as const) {
    is(`${what}: the buyer is not told it won't be suggested again`, (await dismiss(answer)) !== "gone", true);
  }

  done();
}

void main();
