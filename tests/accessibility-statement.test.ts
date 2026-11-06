/**
 * 310 [AX2] §6 and DA1: the public page /accessibility
 * (app/accessibility/page.tsx, lib/accessibility-statement.ts). What fails here:
 *   - a test said to run that does not exist in the CI, runs on fewer
 *     browsers or widths than the page says, is not run on each proposed
 *     change, may be skipped or fail quietly, or no longer prints the scope
 *     the page's words describe;
 *   - a gap in docs/accessibility-inventory.json left off the page, or a page
 *     counted as reviewed that the inventory does not record as reviewed, or
 *     a gap without plain public words;
 *   - the records changed after the page's review date (DA1 (b));
 *   - a conformity claim, a seal or a superiority claim on the page;
 *   - no way to report a problem, no word that we use no overlay, no link in
 *     the footer, or the page missing from the sitemap.
 */
import { readFileSync, existsSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import AccessibilityPage from "@/app/accessibility/page";
import { ACCESSIBILITY_CHECKS, REVIEWED_STATUS, STATEMENT_REVIEW, accessibilityGaps, reviewCounts, statementDigest } from "@/lib/accessibility-statement";
import inventory from "@/docs/accessibility-inventory.json";
import { done, is, part } from "./check";

function main(): void {
  part("Every test the page names runs in the CI, as the page says");
  for (const check of ACCESSIBILITY_CHECKS) {
    const workflow = existsSync(check.workflow) ? readFileSync(check.workflow, "utf8") : "";
    const script = existsSync(check.script) ? readFileSync(check.script, "utf8") : "";
    is(`${check.name}: its workflow and its script exist`, [workflow.length > 0, script.length > 0], [true, true]);
    is(`${check.name}: the workflow runs that script`, workflow.includes(`node ${check.script.split("/").pop()}`) || workflow.includes(`node ${check.script}`), true);
    is(`${check.name}: it runs on each proposed change and every day`, [/^on:\s*$/m.test(workflow), /^\s+pull_request:/m.test(workflow), /^\s+- cron: /m.test(workflow)], [true, true, true]);
    is(`${check.name}: no step may fail quietly`, /continue-on-error/.test(workflow), false);
    const gates = workflow.split("\n").filter((line) => /^\s+if:/.test(line)).map((line) => line.trim());
    const allowed = (line: string) =>
      line === "if: ${{ always() }}" ||
      line === "if: env.AX2_PUBLIC_STANDARD == 'true'" ||
      line.startsWith("if: ${{ !cancelled() && needs.documentation-scope.outputs.full != 'false'");
    is(`${check.name}: it is skipped only for a change to documentation alone`, gates.filter((line) => !allowed(line)), []);
    for (const needle of check.proof) is(`${check.name}: the workflow or its script has ${needle}`, (workflow + script).includes(needle), true);
  }
  is("the enhanced contrast rule is named wherever the page says the enhanced level is checked", ACCESSIBILITY_CHECKS.filter((c) => /enhanced/.test(c.what)).every((c) => c.proof.includes('"color-contrast-enhanced"') && c.proof.includes('"wcag2aaa"')), true);

  part("What is open and what is reviewed come from the inventory, in its own public words");
  const gaps = accessibilityGaps();
  const openWork = (inventory as { openWork: { area: string; publicWording?: string }[] }).openWork;
  is("every open item has public words in the inventory", openWork.filter((item) => !item.publicWording || item.publicWording.trim().length < 20).map((item) => item.area), []);
  is("the public words are plain: no internal delivery numbers, no commas without a space, no slashes", gaps.filter((g) => /deliver(y|ies)\s*\d|,\S|\/|\bAAA\/|\bOS\b/i.test(g.words)).map((g) => g.area), []);
  is("the screen reader gap matches the trial the page describes", gaps.some((g) => /NVDA/.test(g.words) && /VoiceOver/.test(g.words) && /sign-up and log-in pages only/.test(g.words)), true);
  is("testing with people who have disabilities is listed as not done", gaps.some((g) => /people who have disabilities: not done yet/i.test(g.words)), true);
  const counts = reviewCounts();
  const templates = (inventory as { pageTemplates: { status: string }[] }).pageTemplates;
  is("a reviewed page needs the exact finished status, which no template has today", [counts.total, counts.reviewed, templates.some((t) => t.status === REVIEWED_STATUS)], [templates.length, 0, false]);

  part("The date of the last review follows the records");
  is("the records the page shows were reviewed on the date it gives", STATEMENT_REVIEW.digest, statementDigest());
  is("the date is a real date", Number.isNaN(Date.parse(STATEMENT_REVIEW.date)), false);

  part("What the page says, and what it never says");
  const html = renderToStaticMarkup(AccessibilityPage());
  const text = html.replace(/<[^>]+>/g, " ");
  is("the goal is said as a goal, not as conformity", [/our goal/i.test(text), /WCAG\s+2\.2/.test(text), /\bAAA\b/.test(text)], [true, true, true]);
  is("no claim of conformity, certification, a seal or being best", /fully accessible|ADA compliant|AAA compliant|AA compliant|WCAG AAA certified|most accessible|certified|compliant with|conforms? to|in conformance|meets WCAG|meets level|fully meets|100% accessible|accessible to everyone|more accessible than|best in class/i.test(text), false);
  is("every gap is on the page, in its public words", gaps.every((g) => text.includes(g.words.replace(/'/g, "&#x27;"))), true);
  is("no internal area names or statuses on the page", openWork.some((item) => text.includes(item.area)), false);
  is("no unverifiable promise to read every message", /read every message/i.test(text), false);
  is("an alternative is offered where something stops a person", /another way to help you finish it/.test(text), true);
  is("not shown as terms with an effective date", /Effective /.test(text), false);
  is("the glossary expands the screen readers and engines it names", [/NonVisual Desktop Access/.test(text), /Job Access With Speech/.test(text), /WebKit in Safari/.test(text)], [true, true, true]);
  is("how many pages still wait for a full review is said", text.includes(`${counts.total - counts.reviewed} of ${counts.total}`), true);
  is("no widget or overlay, said plainly", /no accessibility widget or overlay/i.test(text), true);
  is("how to report a problem, without a promised reply time", [html.includes("mailto:support@marktmorgen.com"), /within \d+ (hours|days)|24\/7|24 hours/i.test(text)], [true, false]);
  is("a glossary for the terms it uses", [/<dl/.test(html), /screen reader/i.test(text), /<abbr title="Web Content Accessibility Guidelines">WCAG<\/abbr>/.test(html)], [true, true, true]);
  is("creators' stores: what the studio checks, and that their content is theirs", [/Can everyone use your store\?/.test(text), /responsible for what they publish/i.test(text)], [true, true]);

  part("Where it is found");
  const footer = readFileSync("components/site-footer.tsx", "utf8");
  is("in the footer's legal links, which the slim footer uses too", /const LEGAL_LINKS[\s\S]*?\{ label: "Accessibility", href: "\/accessibility" \}[\s\S]*?\];/.test(footer), true);
  is("in the sitemap", /path: "\/accessibility"/.test(readFileSync("app/sitemap.ts", "utf8")), true);
  done();
}

main();
