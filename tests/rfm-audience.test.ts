/**
 * The kinds of buyer in the email composer (270 [GR1], unit 3b; added 2
 * November 2026, components/email-studio.tsx). Its filtering, reading and
 * checking are tested in tests/segments.test.ts and
 * tests/broadcast-response.test.ts; this checks, from the source, that the
 * composer sends the kind everywhere the audience goes (count, draft, send,
 * saved group, set-aside copy), shows each kind's rule under the field, and
 * says it in the audience summary.
 */
import { readFileSync } from "node:fs";
import { RFM_GROUPS } from "@/lib/rfm-rules";
import { done, is, part } from "./check";

const studio = readFileSync("components/email-studio.tsx", "utf8").replace(/\s+/g, " ");

part("Everywhere the audience goes");
is("in the narrowing the count, the draft, the send and a saved group read", studio.includes("const narrow: Narrow = { minSpent, channel, quietDays, ...(buyerGroup ? { group: buyerGroup } : {}), ...(activeDays ? { activeDays } : {}) };"), true);
is("counted when it changes, and kept when the composer is set aside", [studio.includes("quietDays, activeDays, buyerGroup, more, countRevision"), studio.includes("label, buyerGroup });"), studio.includes("channel, quietDays, activeDays, buyerGroup, draftSubjectTest, label]);")], [true, true, true]);
is("a draft with only a kind still keeps its narrowing", studio.includes("narrow: minSpent || channel || quietDays || buyerGroup || activeDays ? narrow : null"), true);
is("a saved group brought back sets it", studio.includes('setBuyerGroup(segment.group ?? "");'), true);

part("What the creator reads");
is("one field, its label and its hint linked", [studio.includes('<label className="block" htmlFor="mail-group"> <span className="field-label">Only one kind of buyer</span>'), studio.includes('aria-describedby="mail-group-hint"')], [true, true]);
is("each kind by name, its rule under the field", [RFM_GROUPS.every((g) => g.rule.length > 10), studio.includes("RFM_GROUPS.find((g) => g.id === buyerGroup)?.rule")], [true, true]);
is("and in the audience summary", studio.includes("are among your \\u201c${RFM_GROUPS.find((g) => g.id === narrow.group)?.name ?? narrow.group}\\u201d"), true);

part("How many of each kind (unit 3c)");
const route = readFileSync("app/api/store/mail/route.ts", "utf8").replace(/\s+/g, " ");
is("counted from the ledger the choices already read, with the channels, at the same moment as the kind kept", [route.includes("const keep = isNarrowed(narrow) ? keeps(narrow, ledger, now) : undefined;"), route.includes("channels: ledgerChannels(ledger), // How many of the store's buyers are of each kind (270 [GR1], unit 3c), from the same ledger: no extra read. kinds: Object.fromEntries(rfmSummary(ledger.buyers.values(), now).map((k) => [k.id, k.buyers])),")], [true, true]);
is("each beside its name, only a whole count taken, and said to be all buyers", [studio.includes("`${g.name} (${n(kinds[g.id] as number)} ${kinds[g.id] === 1 ? \"buyer\" : \"buyers\"})`"), studio.includes("Number.isSafeInteger(read[g.id]) && (read[g.id] as number) >= 0"), studio.includes("The number beside each kind is all your buyers of that kind, on your list or not, before the choices above.")], [true, true, true]);

done();
