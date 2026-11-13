/**
 * "Continue with Google" carries Google's G in its standard colors (Google's
 * sign-in branding guidelines, read by Claude 1 on 05/11/2026: the button
 * "must always include the standard color for the Google 'G'", on white,
 * size and colors unchanged). The G is decoration beside the words, so a
 * screen reader hears the button's visible name only (AX274: no image of
 * text, 2.5.5 a 44 px target, 2.4.13 focus visible).
 */
import { createElement } from "react";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { GoogleSignIn } from "@/components/google-signin";
import { done, is } from "./check";

const html = renderToStaticMarkup(createElement(GoogleSignIn, { handle: "" }));
const button = /<button[^>]*>[\s\S]*?<\/button>/.exec(html)?.[0] ?? "";

/** The button's words: tags taken out until none is left, so a tag cut in two cannot leave one behind. */
const wordsOf = (markup: string): string => {
  let text = markup;
  for (let before = ""; before !== text; ) {
    before = text;
    text = text.replace(/<[^>]*>/g, "");
  }
  return text.replace(/[<>]/g, "");
};
is("the button still says Continue with Google", wordsOf(button).trim(), "Continue with Google");
is("it carries an svg G hidden from screen readers and from the tab order", /<svg[^>]*aria-hidden="true"[^>]*focusable="false"/.test(button), true);
is("in Google's four standard colors", ["#4285F4", "#34A853", "#FBBC05", "#EA4335"].map((c) => button.includes(`fill="${c}"`)), [true, true, true, true]);
is("on white, whatever the page's colors", /bg-white[^"]*"[^>]*>\s*<svg/.test(button), true);
is("a target of at least 44 px", /<button[^>]*class="[^"]*min-h-11/.test(button), true);
is("no image of text: the words are text", /<img[^>]*alt="[^"]+"/.test(button), false);
// Codex U's LOW on #2671 (proof codex/u-review-2671-doc-state-proof@05708df9): the guide's opening state
// separates what no agent did from what the owner already checked in Google Cloud.
const guide = readFileSync("docs/google-signin.md", "utf8");
is("the guide still records the feature as disabled", guide.includes("GOOGLE_SIGNIN_APPROVED` é `false"), true);
is("the guide records that the owner checked steps 2 through 7", guide.includes("O dono conferiu os passos 2 a 7"), true);
is("the guide records the renamed project", guide.includes('agora com o nome "Marktmorgen"'), true);
is("the opening state no longer says that nothing was done in Google Cloud", guide.includes("Nada foi feito no Google Cloud"), false);
is("it says that no agent acted there", guide.includes("Nenhum agente fez nada no Google Cloud"), true);
// Codex E2's LOW on #2671 (docs/reviews/e2-2671-a1ba.md): no official source gives this flow's price, so the guide
// never says it is not charged per call; it says the price is unknown and not checked in an official source.
is("the guide never says the OAuth flow is not charged per call", /não cobrado por chamada/i.test(guide), false);
is("it says Google's price for this flow is unknown", guide.includes("**desconhecido, não conferido em fonte oficial**"), true);
is("and the setup's price step says the same", guide.includes("1. **Preço:** desconhecido, não conferido em fonte oficial"), true);
done();
