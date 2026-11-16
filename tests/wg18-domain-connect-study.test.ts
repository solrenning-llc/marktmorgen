/**
 * 658 [WG18] Domain Connect study: the draft and its risks say what the
 * official sources say (Codex S and Claude 5 on #2753).
 *
 * - A CNAME at the template's own host needs `hostRequired: true`, or the
 *   Templates linter rejects it (DCTL1012); with it, the apex cannot use that
 *   template. So the apex and the subdomain are two templates.
 * - A signed apply link is made in the browser of whoever claimed the domain,
 *   so keeping it "inside the studio" does not stop a hostile claim: the risk
 *   is open and worse than today, and it is the owner's.
 * - Unmeasured work is unknown, never zero; fields Cloudflare ignores are said
 *   to be ignored; plans go by their public names.
 *
 * Reads the document only. No network, no provider, no account.
 */
import { readFileSync } from "node:fs";
import { done, is, part } from "./check";

const doc = readFileSync("docs/domain-connect-study-2026-11-06.md", "utf8");
const has = (text: string) => doc.includes(text);
const section = (heading: string): string => {
  const start = doc.indexOf(heading);
  if (start < 0) return "";
  const next = doc.indexOf("\n## ", start + heading.length);
  return next < 0 ? doc.slice(start) : doc.slice(start, next);
};

part("the draft: the apex and the subdomain are two templates");
const draft = section("### What Marktmorgen would publish");
is("no single template for both", has("so one template serves `example.com` and `shop.example.com`"), false);
is("the subdomain template sets hostRequired true", draft.includes("`hostRequired: true`"), true);
is("the linter rule is named", draft.includes("DCTL1012"), true);
is("the apex template has no CNAME at @", /apex[^\n]*\|[^\n]*CNAME @/.test(draft), false);
is("Vercel's template is no model for %subdomain% in host", draft.includes("%subdomain%"), true);

part("fields Cloudflare ignores are said to be ignored");
is("txtConflictMatchingMode ignored by Cloudflare", /txtConflictMatchingMode[^\n]*ignore/i.test(doc), true);
is("syncRedirectDomain ignored by Cloudflare", /syncRedirectDomain[^\n]*ignore/i.test(doc), true);
is("hostRequired ignored by Cloudflare", /Cloudflare[^\n]*`?hostRequired`?[^\n]*ignore/i.test(doc), true);

part("the residual risk is open and worse than today");
is("not called the same as today", has("Residual risk (same as today)"), false);
is("the link-only-in-the-studio mitigation is gone", has("Mitigation: show the link only inside the studio"), false);
is("said to be worse than today", /Residual risk[^\n]*worse than today/i.test(doc), true);
is("the owner's section names it", /phishing|hostile claim/i.test(section("## 8. Depende do dono")), true);

part("unknown is never zero, and every claim is literally true");
is("no study cost of none", has("Study cost: none"), false);
is("the study's own work is unknown", /study[^\n]*unknown, not zero/i.test(section("## 6.")), true);
is("the PR wording names the upstream template PR", has("no pull request was opened"), false);
is("no unproved rarity or apex placement", has("rare, and its host sits at the apex"), false);
is("plans go by their public names", [has("a Pro feature"), /Studio and Scale/.test(section("## 1."))], [false, true]);

done();
