/**
 * Canada is asked first (finding by session 5FNwB on main, passed on by the coordinator, 15 November 2026), RED before
 * the fix: lib/pixels.ts CONSENT_COUNTRIES had no "CA", so a visitor from Canada, Quebec included, loaded Meta, Google,
 * TikTok and the other ad pixels without being asked (components/store-tracking.tsx), and the proxy set the affiliate
 * and channel cookies on arrival (proxy.ts). Quebec's Law 25 (an Act respecting the protection of personal
 * information in the private sector, s. 8.1) wants tracking off by default; the visitor's country header does not say
 * the province, so the whole country is asked first. The official text of Law 25 was not re-read on 15 November 2026.
 * The pages that name the places asked first say Canada too, so none promises less than the code does.
 */
import { readFileSync } from "node:fs";
import { needsConsent, pixelChoiceState } from "@/lib/pixels";
import { done, is, part } from "./check";

part("A visitor from Canada is asked first, and nothing loads without their yes");
is("Canada needs consent", needsConsent("CA"), true);
is("with no choice yet, the pixels wait for the question", pixelChoiceState(undefined, needsConsent("CA"), false), "ask");
is("a stored value that is not yes is never consent", pixelChoiceState("y", needsConsent("CA"), false), "ask");
is("only their yes turns them on", pixelChoiceState("yes", needsConsent("CA"), false), "on");
is("control: the United States is still not asked first", needsConsent("US"), false);

part("Every page that names the places asked first names Canada");
const pages = [
  "app/privacy/page.tsx",
  "app/terms/page.tsx",
  "components/pixel-editor.tsx",
  "components/stats-panel.tsx",
  "lib/feature-pages.ts",
  "lib/help-content.ts",
];
for (const file of pages) {
  const text = readFileSync(file, "utf8").replace(/\s+/g, " ");
  // Each sentence that lists Switzerland and Brazil as a place where the law asks first lists Canada with them.
  const lists = [...text.matchAll(/Switzerland,? (?:and|or) Brazil/g)].length + [...text.matchAll(/Switzerland, Brazil\)/g)].length;
  is(`${file}: no list of the places asked first leaves Canada out`, lists, 0);
}
done();
