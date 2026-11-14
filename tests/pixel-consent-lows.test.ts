/**
 * The LOWs of the reviews at 39fcb89f52 on #4241 (tracking consent):
 * - TikTok's own first-party session cookies (ttcsid, ttcsid_<pixel code>; TikTok's help page "About using cookies
 *   with TikTok Pixel") were not expired after a no, and Google's conversion linker keeps ad clicks in Local Storage
 *   under _gcl_ls (Google Tag Manager help, "Conversion linker"): ePrivacy art. 5(3) covers any storage;
 * - the privacy policy said every sign-up is sent with the hashed email, while a free copy or a waitlist sign-up is
 *   now sent without it;
 * - opening "Ad measurement settings" and answering left focus on <body> (2.4.3).
 * Pure functions and the sources the page is built from.
 */
import { readFileSync } from "node:fs";
import * as consent from "@/lib/ad-consent";
import { done, is, part } from "./check";

part("TikTok's session cookies go with the yes");
is("ttcsid and ttcsid_<pixel code> are platform cookies", ["ttcsid", "ttcsid_C4ABCDEF12GHIJ3KLMN"].map((n) => consent.PLATFORM_COOKIE.test(n)), [true, true]);
is("a look-alike is not", ["ttcsid_", "xttcsid", "ttcsid_a;b"].map((n) => consent.PLATFORM_COOKIE.test(n)), [false, false, false]);

part("So does what the scripts keep in the browser's storage");
const keys = (consent as unknown as { platformStorageKeys?: (k: string[]) => string[] }).platformStorageKeys;
is("Google's _gcl_ls is found, nothing of the site's", keys?.(["_gcl_ls", "theme", "nl_consent:harbor", "_gcl_lsx"]), ["_gcl_ls"]);
const page = readFileSync("components/store-pixels.tsx", "utf8");
const off = page.slice(page.indexOf("if (!on) {"), page.indexOf("return;", page.indexOf("if (!on) {")));
is("the off branch removes them from localStorage and sessionStorage", [/platformStorageKeys\(/.test(off), /localStorage\.removeItem/.test(off), /sessionStorage\.removeItem/.test(off)], [true, true, true]);

part("The privacy policy says which sign-ups go without the address");
const privacy = readFileSync("app/privacy/page.tsx", "utf8").replace(/\s+/g, " ");
is("free copies and waitlists are sent without the email address", /sign-up for something free or a waitlist is sent without it/.test(privacy), true);

part("Focus follows the banner (2.4.3)");
is("opening the settings moves focus to the banner's first button", /bannerFirst\.current\?\.focus\(\)/.test(page), true);
is("answering moves focus back to the settings link", /settingsLink\.current\?\.focus\(\)/.test(page), true);
done();
