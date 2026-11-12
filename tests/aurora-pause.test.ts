/**
 * The Aurora backdrop drifts behind a store's pages for as long as they are open (lib/store-look.ts, backdropStyle;
 * app/globals.css, st-aurora), so it needs a way to stop it (WCAG 2.2.2 Pause, Stop, Hide; AX274 2.3.3). Checked:
 *
 * - around every page of a store whose backdrop is the Aurora, the layout draws a pause button, a real <button>
 *   with aria-pressed, in the store's words and marked with its lang, in each of the 7 languages;
 * - no button around a store whose backdrop does not move, nor around a suspended store;
 * - the page's stylesheet stops the drift when the button is pressed, and still for a device that asked for less
 *   motion (where the button is not shown, since nothing moves);
 * - the studio's preview tile of the Aurora stands still, as a picture of it.
 */
import { createElement } from "react";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import StoreLayout from "@/app/[handle]/layout";
import { LANGUAGE_CODES, LANGUAGES } from "@/lib/store-language";
import { BACKDROP_PAUSE_WORDS, backdropPauseWords } from "@/lib/buyer-words/backdrop-pause";
import { claimHandle, ensureListId, ensureStatsId, ensureStoreId, setLanguage, setSubscription, storeForEmail, updateLook } from "@/lib/store";
import { answering } from "./security/next-headers";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const OWNER = "aurora@example.com";

async function draw(): Promise<string> {
  const store = (await storeForEmail(OWNER))!;
  answering(new Request(`https://marktmorgen.com/@${store.handle}`));
  try {
    const node = await StoreLayout({ children: createElement("div", { id: "page" }, "PAGE"), params: Promise.resolve({ handle: `@${store.handle}` }) } as never);
    return renderToStaticMarkup(node as React.ReactElement);
  } finally {
    answering(null);
  }
}

const pauseButton = (html: string) => html.match(/<button\b[^>]*\bdata-backdrop-pause\b[^>]*>([\s\S]*?)<\/button>/);

async function main(): Promise<void> {
  redis.clear();
  await claimHandle(OWNER, "aurora-lab", "Aurora Lab", "");
  await ensureStatsId(OWNER);
  await ensureListId(OWNER);
  await ensureStoreId(OWNER);
  await setSubscription(OWNER, { customerId: "cus_AuroraPause0001", subscriptionId: "sub_AuroraPause0001", active: true, period: paidPeriod() });
  const look = (await storeForEmail(OWNER))!.look;

  part("Around a store whose backdrop is the Aurora, a pause button in the store's words");
  await updateLook(OWNER, { ...look, backdrop: "aurora" });
  for (const code of LANGUAGE_CODES) {
    await setLanguage(OWNER, code);
    const html = await draw();
    const button = pauseButton(html);
    is(`${code}: a pause button is drawn`, Boolean(button), true);
    is(`${code}: it says the store's words`, button?.[1]?.includes(BACKDROP_PAUSE_WORDS[code].pause), true);
    is(`${code}: it is marked with the store's language`, button ? new RegExp(`\\blang="${LANGUAGES[code].locale}"`).test(button[0]) : false, true);
    is(`${code}: it says whether it is pressed`, button ? /\baria-pressed="false"/.test(button[0]) : false, true);
    is(`${code}: it is a button, never a submit`, button ? /\btype="button"/.test(button[0]) : false, true);
    is(`${code}: the words are in every language`, backdropPauseWords(code).play.length > 0 && backdropPauseWords(code).pause.length > 0, true);
  }

  part("Nothing around a store whose backdrop does not move");
  for (const backdrop of ["plain", "glow", "dots", "grid"] as const) {
    await updateLook(OWNER, { ...look, backdrop });
    is(`${backdrop}: no pause button`, pauseButton(await draw()), null);
  }

  part("The stylesheet stops the drift when pressed, and for less motion");
  const css = readFileSync("app/globals.css", "utf8");
  is("a pressed button pauses every store page's drift", /\[data-backdrop-still\][^{]*\.st-page\s*\{[^}]*animation-play-state:\s*paused/.test(css), true);
  is("less motion still stops it", /@media \(prefers-reduced-motion: reduce\)\s*\{\s*\.st-page\s*\{\s*animation:\s*none/.test(css), true);
  const lessMotion = css.match(/@media \(prefers-reduced-motion: reduce\)\s*\{\s*\.st-page\s*\{[\s\S]*?\n\}/)?.[0] ?? "";
  is("the button is not shown where nothing moves", /\[data-backdrop-pause\]\s*\{\s*display:\s*none/.test(lessMotion), true);

  part("The studio's preview tile stands still");
  const editor = readFileSync("components/look-editor.tsx", "utf8");
  is("the tile overrides the drift to paused", /"--st-backdrop-play": "paused"/.test(editor), true);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
