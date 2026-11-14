/**
 * Dark mode, stage 2 (complement WG (a) of 274 [AX1], 10 November 2026): the reader's choice of "Light", "Dark" or
 * "Match my device", and the one plain script that applies it before the first paint.
 *
 * Light stays the default. Nobody who has not chosen sees any change: with nothing chosen, the script below reads one
 * key, finds nothing and touches nothing, so the page is drawn exactly as before. The choice is kept in this browser's
 * localStorage only. It is never a cookie, so it is never sent to us with a request, and no server reads it.
 *
 * Why a plain script in <head>: the page is rendered on the server, which cannot know the choice. If React applied
 * it, the page would first paint light and then turn dark (the flash). A synchronous script in <head> runs while the
 * HTML is parsed, before anything is painted (Next.js 16 guide "How to prevent flash before hydration", section
 * "Themes", node_modules/next/dist/docs/01-app/02-guides/preventing-flash-before-hydration.md, read 10 November 2026).
 * It carries no nonce, so lib/csp.ts allows it by its SHA-256 hash, like the two in lib/reveal-scripts.ts;
 * tests/dark-scheme-switch.test.ts checks that the hash is this script's own.
 *
 * The attribute it sets, data-color-scheme="dark" on <html>, turns on the dark tokens of lib/dark-tokens.ts only on
 * the pages they have been proved on (DARK_READY in that file). Every other page stays light, chosen or not.
 */

/** The localStorage key. One short value; nothing that names the reader. */
export const COLOR_SCHEME_KEY = "mm-color-scheme";

export const COLOR_SCHEME_CHOICES = ["light", "dark", "system"] as const;
export type ColorSchemeChoice = (typeof COLOR_SCHEME_CHOICES)[number];

/** The words of each choice, as the switch shows them. */
export const COLOR_SCHEME_LABELS: Record<ColorSchemeChoice, string> = {
  light: "Light",
  dark: "Dark",
  system: "Match my device",
};

export const DARK_QUERY = "(prefers-color-scheme: dark)";

/**
 * The script, as written into <head> by app/layout.tsx. With no choice, or "light", or anything it does not know, it
 * does nothing at all: no attribute is set or removed. "dark" sets the attribute; "system" sets it when the device
 * asks for dark, and follows the device if that changes while the page is open, but only while the kept choice is
 * still "system": once the reader picks Light or Dark in the switch, a later change of the device changes nothing
 * (the listener reads the key again each time). Any error leaves the page light.
 */
export const COLOR_SCHEME_SCRIPT =
  '(function(){try{var c=localStorage.getItem("mm-color-scheme");' +
  'if(c!=="dark"&&c!=="system")return;' +
  'var r=document.documentElement;' +
  'if(c==="dark"){r.setAttribute("data-color-scheme","dark");return}' +
  'var m=window.matchMedia&&window.matchMedia("(prefers-color-scheme: dark)");if(!m)return;' +
  'var a=function(){try{if(localStorage.getItem("mm-color-scheme")!=="system")return}catch(e){return}' +
  'if(m.matches){r.setAttribute("data-color-scheme","dark")}else if(r.hasAttribute("data-color-scheme")){r.removeAttribute("data-color-scheme")}};' +
  'a();if(m.addEventListener){m.addEventListener("change",a)}' +
  '}catch(e){}})()';

/** Its hash, as a Content-Security-Policy source list writes it. */
export const COLOR_SCHEME_HASH = "'sha256-CqaBtkbkpsTsUXYy7eBfjoNHPIjf3OFT+1gh3Gi8Qi8='";

/** Read a stored value as a choice. Anything unknown is light, the default; it is never guessed to be dark. */
export function toChoice(value: string | null | undefined): ColorSchemeChoice {
  return value === "dark" || value === "system" ? value : "light";
}

/** Whether a choice draws the page dark, given whether the device asks for dark. */
export function isDark(choice: ColorSchemeChoice, deviceDark: boolean): boolean {
  return choice === "dark" || (choice === "system" && deviceDark);
}
