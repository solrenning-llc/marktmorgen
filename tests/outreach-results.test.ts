/**
 * What the creator's own pitches did (lib/outreach-results.ts,
 * components/outreach-results.tsx, 501 [OX3]; added 12 November 2026).
 * Synthetic pitches only. Checked:
 *
 *   - drafts are not sent; "replied" and "deal" are answers; "stopped" is
 *     said apart and is never an answer;
 *   - below 5 sent, "Not enough data yet" and no share or tip; a goal with
 *     fewer than 5 is never compared;
 *   - one goal is said to get answers more often only when strictly more
 *     often than another with enough sent, both counts given; a tie says
 *     nothing; no answer at all is said plainly;
 *   - the table has row and column headers, and the card says nothing tracks
 *     opens;
 *   - in the real Outreach studio the card is drawn from the list it shows,
 *     so marking a pitch as answered changes the numbers at once.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MIN_SENT, outreachResults } from "@/lib/outreach-results";
import { OutreachResultsCard } from "@/components/outreach-results";
import { OutreachStudio } from "@/components/outreach-studio";
import type { OutreachGoal, Pitch, PitchStatus } from "@/lib/outreach-rules";
import { find, mount } from "./client-hooks";
import { done, is, part } from "./check";

const p = (goal: OutreachGoal, status: PitchStatus) => ({ goal, status });
const many = (goal: OutreachGoal, status: PitchStatus, count: number) => Array.from({ length: count }, () => p(goal, status));

async function main(): Promise<void> {
  part("Nothing yet, or too few");
  is("no pitch: nothing shown", outreachResults([]), { kind: "none" });
  const few = outreachResults([...many("sponsor", "sent", 2), p("sponsor", "replied"), p("partner", "draft")]);
  is(`below ${MIN_SENT} sent: not enough data, no share`, few, { kind: "few", sent: 3, drafts: 1, next: "Not enough data yet: 3 pitches sent. Once you have sent 5, this shows what got answers. You have 1 draft not sent yet." });
  is("drafts are not sent pitches", outreachResults(many("sponsor", "draft", 9)).kind, "few");

  part("Counted by goal");
  {
    const r = outreachResults([...many("sponsor", "sent", 4), ...many("sponsor", "replied", 2), p("sponsor", "deal"), ...many("sponsor", "stopped", 3), ...many("partner", "sent", 2)]);
    is("sent, answered (replied or deal), deals, asked to stop", r.kind === "rows" ? r.rows.map((row) => [row.goal, row.sent, row.answered, row.deals, row.stopped, row.enough]) : r.kind, [["sponsor", 10, 3, 1, 3, true], ["partner", 2, 0, 0, 0, false]]);
    is("a goal with too few is not compared, and nothing is invented", r.kind === "rows" ? r.next : null, null);
  }

  part("The next step says only what the numbers show");
  {
    const better = outreachResults([...many("sponsor", "replied", 3), ...many("sponsor", "sent", 7), p("partner", "replied"), ...many("partner", "sent", 7), p("business", "draft")]);
    is("one goal answered more often, with both counts", better.kind === "rows" ? better.next : null, "Your sponsor pitches got answers more often (3 of 10) than your partner pitches (1 of 8). Your next pitches could be to sponsors. You have 1 draft not sent yet.");
    const businesses = outreachResults([...many("business", "deal", 2), ...many("business", "sent", 3), ...many("sponsor", "sent", 5)]);
    is("businesses are said as businesses that would buy", businesses.kind === "rows" ? businesses.next : null, "Your business pitches got answers more often (2 of 5) than your sponsor pitches (0 of 5). Your next pitches could be to businesses that would buy.");
    const tie = outreachResults([p("sponsor", "replied"), ...many("sponsor", "sent", 4), p("partner", "replied"), ...many("partner", "sent", 4)]);
    is("a tie says nothing", tie.kind === "rows" ? tie.next : null, null);
    const stops = outreachResults([...many("sponsor", "stopped", 5), ...many("partner", "sent", 5)]);
    is("asking to stop is never an answer", stops.kind === "rows" ? stops.next : null, "None of the 10 pitches you sent has an answer marked yet.");
  }

  part("The card");
  {
    const html = renderToStaticMarkup(createElement(OutreachResultsCard, { results: outreachResults([...many("sponsor", "replied", 2), ...many("sponsor", "sent", 3), ...many("partner", "sent", 1)]) }));
    is("a table with column and row headers", [(html.match(/<th scope="col"/g) ?? []).length, (html.match(/<th scope="row"/g) ?? []).length], [5, 2]);
    is("a goal with enough says x of y; one with too few says so", [/<td class="px-3">2 of 5<\/td>/.test(html), /0 \(not enough sent yet to compare\)/.test(html)], [true, true]);
    is("it says nothing tracks opens", /Nothing tracks whether an email was opened\./.test(html), true);
    is("nothing for a store with no pitch", renderToStaticMarkup(createElement(OutreachResultsCard, { results: outreachResults([]) })), "");
    is("no urgency words", /hurry|today only|don't miss|last chance|act now/i.test(html), false);
  }

  part("In the real studio, the numbers follow the list");
  {
    const pitch = (id: string, goal: OutreachGoal, status: PitchStatus): Pitch => ({ id, goal, status, domain: `${id}.example`, company: id, to: `hello@${id}.example`, role: true, country: "US", page: `https://${id}.example/contact`, line: "", foundAt: 1, subject: "Hi", body: "Hello", footer: "", stop: "", createdAt: 1, sentAt: status === "draft" ? 0 : 2 });
    const pitches = Array.from({ length: 5 }, (_, i) => pitch(`s${i}`, "sponsor", "sent"));
    const shown = await mount(OutreachStudio, { sender: { name: "Ana", address: "1 Main St" }, pitches, left: 0, on: false, off: null, storeUrl: "https://marktmorgen.com/@ana" });
    const card = () => find(shown.tree(), (n) => n.type === OutreachResultsCard)[0];
    const answered = () => {
      const r = card().props?.results as ReturnType<typeof outreachResults>;
      return r.kind === "rows" ? r.rows[0].answered : -1;
    };
    is("the card is in the studio, from its pitches", answered(), 0);
    const cardOf = find(shown.tree(), (n) => typeof n.props?.onChange === "function" && (n.props?.pitch as Pitch | undefined)?.id === "s0")[0];
    (cardOf.props?.onChange as (next: Pitch) => void)({ ...pitches[0], status: "replied" });
    await shown.settle();
    is("marking one as answered changes the numbers at once", answered(), 1);
  }
  done();
}

void main();
