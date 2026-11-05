/**
 * "Bought in the last…" (461 [EL5], unit 1; lib/segments-rules.ts,
 * lib/segments.ts, the composer in components/email-studio.tsx; added 2
 * November 2026). The buyers still active, from the same buyers' ledger as
 * the other narrowings; never opens, never anyone who never bought. Checked:
 *
 *   - only 30, 60, 90 or 180 days are read; anything else is no narrowing,
 *     and nothing of it is added to an email or group saved before it;
 *   - a record with the field is told apart from one without, so a kept
 *     email or draft is never read as a broader group;
 *   - who is kept: bought within the days; not someone who bought before
 *     them, nor someone who never bought; with "has not bought in", only
 *     those in between;
 *   - the composer offers it with its help, and says when the two choices
 *     leave nobody (read in its source).
 */
import { readFileSync } from "node:fs";
import { ACTIVE_DAYS, isNarrowed, readNarrow, sameNarrow } from "@/lib/segments-rules";
import { keeps } from "@/lib/segments";
import { done, is, part } from "./check";

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 10, 2, 12);

part("What is read");
is("the choices", [...ACTIVE_DAYS], [30, 60, 90, 180]);
is("one of them is kept", readNarrow({ minSpent: 0, channel: "", quietDays: 0, activeDays: 60 }), { minSpent: 0, channel: "", quietDays: 0, activeDays: 60 });
is(
  "45 days is no narrowing; the number 30 written as text is read as 30 (as quietDays is), and a kept record with it as text is refused by sameNarrow below; nothing is added to what was saved before",
  [readNarrow({ activeDays: 45 }), readNarrow({ activeDays: "30" }), readNarrow({ minSpent: 0, channel: "", quietDays: 0 })].map((n) => "activeDays" in n && n.activeDays !== undefined),
  [false, true, false],
);
is("it narrows on its own", [isNarrowed({ minSpent: 0, channel: "", quietDays: 0, activeDays: 30 }), isNarrowed({ minSpent: 0, channel: "", quietDays: 0 })], [true, false]);
is(
  "a kept record with it is never read as one without, nor the other way",
  [
    sameNarrow({ minSpent: 0, channel: "", quietDays: 0, activeDays: 30 }, readNarrow({ minSpent: 0, channel: "", quietDays: 0, activeDays: 30 })),
    sameNarrow({ minSpent: 0, channel: "", quietDays: 0, activeDays: 30 }, readNarrow({ minSpent: 0, channel: "", quietDays: 0 })),
    sameNarrow({ minSpent: 0, channel: "", quietDays: 0 }, readNarrow({ minSpent: 0, channel: "", quietDays: 0, activeDays: 30 })),
    sameNarrow({ minSpent: 0, channel: "", quietDays: 0, activeDays: 45 }, readNarrow({ minSpent: 0, channel: "", quietDays: 0, activeDays: 45 })),
  ],
  [true, false, false, false],
);

part("Who is kept");
const ledger = {
  buyers: new Map([
    ["recent@example.com", { cents: 1000, last: NOW - 10 * DAY, channel: "direct", orders: 1 }],
    ["middle@example.com", { cents: 1000, last: NOW - 45 * DAY, channel: "direct", orders: 2 }],
    ["old@example.com", { cents: 1000, last: NOW - 200 * DAY, channel: "direct", orders: 1 }],
    ["imported@example.com", { cents: 0, last: 0, channel: "imported", orders: 0 }],
  ]),
  partial: false,
};
const kept = (narrow: Parameters<typeof keeps>[0]) => ["recent@example.com", "middle@example.com", "old@example.com", "imported@example.com", "never@example.com"].filter(keeps(narrow, ledger as never, NOW));
is("bought in the last 30 days", kept(readNarrow({ activeDays: 30 })), ["recent@example.com"]);
is("bought in the last 60 days", kept(readNarrow({ activeDays: 60 })), ["recent@example.com", "middle@example.com"]);
is("bought in the last 180 days: not someone who bought before, nor one with no purchase date, nor someone who never bought", kept(readNarrow({ activeDays: 180 })), ["recent@example.com", "middle@example.com"]);
is("with \"has not bought in the last 30\": only those in between", kept(readNarrow({ quietDays: 30, activeDays: 60 })), ["middle@example.com"]);

part("The composer");
const studio = readFileSync("components/email-studio.tsx", "utf8");
is(
  "a labeled choice with its help, sent with the email and its count, and said in the email's summary",
  [studio.includes('<span className="field-label">Bought in the last</span>'), studio.includes('aria-describedby="mail-active-help"'), studio.includes("...(activeDays ? { activeDays } : {})"), studio.includes('narrow.activeDays ? `bought in the last ${narrow.activeDays} days` : ""')],
  [true, true, true, true],
);
is(
  "it says when the two choices leave nobody, read out from either choice as it changes",
  [studio.includes("Nobody can both have bought in these days and not have bought in the days above. Change one of them."), (studio.match(/aria-describedby="mail-active-help"/g) ?? []).length, studio.includes('<span id="mail-active-help" className="field-hint mt-1 block" aria-live="polite">')],
  [true, 2, true],
);

done();
