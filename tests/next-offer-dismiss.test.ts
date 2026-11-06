/**
 * "No thanks" on the next product after a purchase
 * (components/next-offer-box.tsx). The buyer's no is sent to
 * /api/store/assistant-next, which keeps it on the order (lib/next-offer.ts,
 * dismissNextOffer) so neither the page nor the order's email shows the
 * product again. Only a kept no may be confirmed (CX-123 rule 24, client
 * side): before, the box never read the answer, so a dropped connection, a
 * 429 or an error page ended on "Okay. It won't be suggested again for this
 * order." although nothing was kept, and the product came back on reload and
 * in the email.
 *
 * Now only `200 { ok: true }` hides the box with those words. Any other
 * answer keeps the box, with "No thanks" still there to try again, and says
 * the answer was not saved. The handler runs as written in the component,
 * with a stubbed fetch (tests/client-handler.ts).
 */
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { compile, cutBlock, fetchAnswering, recorder } from "./client-handler";
import { NextOfferBox } from "@/components/next-offer-box";
import { NEXT_OFFER_WORDS } from "@/lib/buyer-words/next-offer";
import { done, is, part } from "./check";

const FILE = "components/next-offer-box.tsx";
const SOURCE = readFileSync(FILE, "utf8");
const make = compile<() => Promise<void>>(cutBlock(FILE, "async function hide() {"), ["fetch", "setState", "handle", "session"], "hide");

async function dismiss(answer: typeof fetch) {
  const state = recorder<string>();
  const sent: { url: string; init: RequestInit | undefined }[] = [];
  const spy = (async (url: string, init?: RequestInit) => {
    sent.push({ url, init });
    return answer(url, init);
  }) as typeof fetch;
  await make({ fetch: spy, setState: state.set, handle: "synthetic-store", session: "cs_test_synthetic" })();
  return { states: state.seen, sent };
}

async function main() {
  part("A no the server kept (control: unchanged)");
  const kept = await dismiss(fetchAnswering({ ok: true }));
  is("the box goes, after showing it is sending", kept.states, ["sending", "gone"]);
  is(
    "one POST to the same route with the same body",
    kept.sent.map(({ url, init }) => [url, init?.method, (init?.headers as Record<string, string>)?.["Content-Type"], init?.body]),
    [["/api/store/assistant-next", "POST", "application/json", JSON.stringify({ h: "synthetic-store", s: "cs_test_synthetic" })]],
  );
  is("the words for a kept no are unchanged", NEXT_OFFER_WORDS.en.dismissed, "Okay. It won't be suggested again for this order.");

  part("Any other answer is not a kept no");
  for (const [what, answer] of [
    ["no connection", fetchAnswering(new TypeError("Failed to fetch"))],
    ["too many requests", fetchAnswering({ ok: false }, 429)],
    ["an error page that is not JSON", fetchAnswering("<html>502</html>", 502)],
    ["the order had no choice to keep (404)", fetchAnswering({ ok: false }, 404)],
    ["200 with ok false", fetchAnswering({ ok: false })],
    ["200 with no ok", fetchAnswering({})],
    ["200 with ok as a string", fetchAnswering({ ok: "true" })],
    ["200 with null", fetchAnswering(null)],
    ["200 that is not JSON", fetchAnswering("<html>ok</html>")],
    ["an ok body on a 500", fetchAnswering({ ok: true }, 500)],
  ] as const) {
    is(`${what}: the box stays and says it was not saved`, (await dismiss(answer)).states, ["sending", "failed"]);
  }

  part("Trying again after a failure");
  const state = recorder<string>();
  const hide = make({ fetch: fetchAnswering({ ok: false }, 429), setState: state.set, handle: "synthetic-store", session: "cs_test_synthetic" });
  await hide();
  const again = make({ fetch: fetchAnswering({ ok: true }), setState: state.set, handle: "synthetic-store", session: "cs_test_synthetic" });
  await again();
  is("a second try that is kept hides the box", state.seen, ["sending", "failed", "sending", "gone"]);

  part("What the box shows");
  is("the kept words only on the 'gone' state", /if \(state === "gone"\) \{\s*return \(\s*<p className="st-muted mt-6 text-sm" role="status">\s*\{dismissed\}/.test(SOURCE), true);
  is("on 'failed', an alert with the not-saved words", /state === "failed" \? \(\s*<p role="alert"[^>]*>\s*\{unsaved\}\s*<\/p>/.test(SOURCE), true);
  is("'No thanks' is disabled only while sending, so it can be pressed again", SOURCE.includes('disabled={state === "sending"}'), true);
  is("the card passes the not-saved words", readFileSync("components/next-offer-card.tsx", "utf8").includes("unsaved={w.unsaved}"), true);
  const shown = renderToStaticMarkup(
    createElement(NextOfferBox, { handle: "synthetic-store", session: "cs_test_synthetic", href: "/synthetic-store/p/x", see: "See it", dismiss: "No thanks", dismissed: NEXT_OFFER_WORDS.en.dismissed, unsaved: NEXT_OFFER_WORDS.en.unsaved, note: "" } as Parameters<typeof NextOfferBox>[0], null),
  );
  is("first drawn: the product and No thanks, with no alert", [shown.includes(">No thanks</button>"), shown.includes('role="alert"'), shown.includes(NEXT_OFFER_WORDS.en.unsaved)], [true, false, false]);

  part("The not-saved words, in every buyer language");
  for (const [language, words] of Object.entries(NEXT_OFFER_WORDS)) {
    const unsaved = (words as { unsaved?: unknown }).unsaved;
    const said = typeof unsaved === "string" && unsaved.length > 20 && unsaved !== words.dismissed;
    const translated = language === "en" || unsaved !== NEXT_OFFER_WORDS.en.unsaved;
    is(`${language}: said, not the kept words, and in that language`, said && translated, true);
  }

  done();
}

void main();
