/**
 * The buyer's no to ad measurement holds in the browser (tracking-consent
 * hunt, November 2026):
 *
 * - Parts of the EU with their own country code (Réunion, Martinique, the
 *   Åland Islands and the rest) are asked first, like the rest of the EU
 *   (lib/pixels.ts CONSENT_COUNTRIES): the visitor's country header gives RE,
 *   not FR, there.
 * - A no, or Global Privacy Control, expires the cookies the platforms' own
 *   scripts kept under the earlier yes (_fbp, _ga, _ttp, _epik, ...), on the
 *   host and its parent domains, unless another store on the same site still
 *   has this browser's yes (lib/ad-consent.ts).
 * - Opening "Ad measurement settings" asks again without erasing a stored no:
 *   looking and leaving never turns the pixels on (components/store-pixels.tsx).
 * - "No thanks" is drawn exactly as "Allow".
 */
import { readFileSync } from "node:fs";
import * as consent from "@/lib/ad-consent";
import { needsConsent, pixelChoiceState } from "@/lib/pixels";
import { done, is, part } from "./check";

type Expiries = (cookieHeader: string, hostname: string, secure: boolean) => string[];
type MayClear = (handle: string, choices: Record<string, string>, gpc: boolean) => boolean;
// Read through the module, so this file still runs, and fails, where the functions are missing.
const mod = consent as unknown as Record<string, unknown>;
const expiries: Expiries = (mod.platformCookieExpiries as Expiries | undefined) ?? (() => []);
const mayClear: MayClear = (mod.mayClearPlatformCookies as MayClear | undefined) ?? (() => false);

part("Parts of the EU with their own country code are asked first");
const territories = ["GF", "GP", "MQ", "RE", "YT", "MF", "AX"];
is("each of them", territories.map(needsConsent), territories.map(() => true));
is("as France and Finland are", [needsConsent("FR"), needsConsent("FI")], [true, true]);
is("control: the United States is not asked first", needsConsent("US"), false);

part("A no expires the platforms' own cookies");
const header = "nl_ads_harbor=y; _fbp=fb.1.1.1; theme=dark; _ga=GA1.2.3; _ga_AB12CD34EF=GS1; _gcl_au=1.1; _ttp=abc; _epik=e; _rdt_uuid=r; _twclid=t; session=s";
const out = expiries(header, "shop.example.co.uk", true);
const named = (name: string) => out.filter((line) => line.startsWith(`${name}=;`) || line.startsWith(`${name}=; `));
is("every platform cookie, on the host itself", ["_fbp", "_ga", "_ga_AB12CD34EF", "_gcl_au", "_ttp", "_epik", "_rdt_uuid", "_twclid"].map((n) => out.includes(`${n}=; Path=/; Max-Age=0; SameSite=Lax; Secure`)), Array(8).fill(true));
is("and on each parent domain a script may have set it on", named("_fbp").map((l) => /Domain=([^;]+)/.exec(l)?.[1] ?? "host"), ["host", ".shop.example.co.uk", ".example.co.uk", ".co.uk"]);
is("nothing else of the site's: not its theme, its session or the store's own cookie", out.some((l) => /^(theme|session|nl_ads_harbor)=/.test(l)), false);
is("Secure only where the page is", expiries("_fbp=1", "localhost", false), ["_fbp=; Path=/; Max-Age=0; SameSite=Lax"]);
is("nothing to expire: nothing written", expiries("theme=dark", "marktmorgen.com", true), []);
is("an address, not a domain: the host only", expiries("_ga=1", "127.0.0.1", false).length, 1);

part("Not while another store on the same site has this browser's yes");
is("no other yes: cleared", mayClear("harbor", { harbor: "no", other: "no" }, false), true);
is("another store's yes: kept for it", mayClear("harbor", { harbor: "no", other: "yes" }, false), false);
is("Global Privacy Control is a no to every store: cleared", mayClear("harbor", { other: "yes" }, true), true);

part("The page");
const page = readFileSync("components/store-pixels.tsx", "utf8");
is("the off branch expires them", /if \(!on\) \{[\s\S]{0,500}platformCookieExpiries\(document\.cookie, location\.hostname/.test(page), true);
const settings = /else \{([\s\S]{0,400}?)setState\("ask"\);\s*\}/.exec(page)?.[1] ?? "";
is("opening the settings does not erase the stored choice", [settings.length > 0, /writeChoice\(handle, null\)/.test(settings)], [true, false]);
is("and a stored no is still off on the next page", pixelChoiceState("no", false, false), "off");
const buttons = [...page.matchAll(/className="([^"]+)"\s*(?:\n\s*)?onClick=\{\(\) => \{\s*(?:const gpc[^\n]*\n\s*)?writeChoice\(handle,\s*(?:gpc \? "no" : "yes"|"no")\)/g)].map((m) => m[1]);
is("\"No thanks\" is drawn exactly as \"Allow\"", [buttons.length, new Set(buttons).size], [2, 1]);
done();
