/**
 * 125 [F2-EMAIL-POLLS]: what sending an email with a poll costs, counted
 * (MR: an unknown cost is never zero). Before an email with a poll goes, its
 * poll is written down or found (lib/mail-poll-votes.ts openPoll, and a
 * sequence round's one read first): at the most POLL_SEND_COMMANDS commands
 * and POLL_SEND_BYTES through the database. Taken as if every monthly email
 * held a poll that had to be written down, on the list-email line, the
 * trial's emails, the list-email pack and the list emails priced for Store.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { COMMAND, COST_LINES, DB_BYTE, LIST_EMAIL_USD, PER_EMAIL, POLL_SEND_USD, nonPayingWorst } from "./plan-cost-registry";
import { PACKS } from "./pricing-usage-proposal-table";
import { POLL_RECORD_BYTES, POLL_SEND_BYTES, POLL_SEND_COMMANDS } from "@/lib/mail-poll-votes";
import { TRIAL_MONTHLY_EMAILS, monthlyEmails } from "@/lib/plan";
import { done, is, part } from "./check";

part("The worst an email with a poll adds");
is("openPoll's eight commands and a round's one read", POLL_SEND_COMMANDS >= 9, true);
is("the record sent and read back", POLL_SEND_BYTES >= 2 * POLL_RECORD_BYTES, true);
is("priced at the registry's own command and byte", POLL_SEND_USD, POLL_SEND_COMMANDS * COMMAND + POLL_SEND_BYTES * DB_BYTE);
is("never zero", POLL_SEND_USD > 0, true);
is("a list email is the provider's price and the poll's", LIST_EMAIL_USD, PER_EMAIL + POLL_SEND_USD);

part("Every place a list email is priced takes it");
const line = COST_LINES.find((l) => l.id === "list-email")!;
is("the list-email line, on every plan", (["creator", "pro", "scale"] as const).map((tier) => line.monthlyUsd(tier)), (["creator", "pro", "scale"] as const).map((tier) => monthlyEmails(tier) * LIST_EMAIL_USD));
is("the line names where the bound is kept", line.sources.some((s) => s.file === "lib/mail-poll-votes.ts" && s.names.includes("POLL_SEND_COMMANDS") && s.names.includes("POLL_SEND_BYTES")), true);
is("the list-email pack", PACKS.find((p) => p.id === "list-email")!.costUsd, 2_500 * LIST_EMAIL_USD);
const registry = readFileSync(join(process.cwd(), "tests/plan-cost-registry.ts"), "utf8");
const optimization = readFileSync(join(process.cwd(), "tests/pricing-optimization-table.ts"), "utf8");
is("the trial's emails", [registry.includes("TRIAL_MONTHLY_EMAILS * LIST_EMAIL_USD"), registry.includes("TRIAL_MONTHLY_EMAILS * PER_EMAIL")], [true, false]);
is("and inside its worst", nonPayingWorst() >= TRIAL_MONTHLY_EMAILS * LIST_EMAIL_USD, true);
is("the list emails priced for Store", [optimization.includes("storeEmails * LIST_EMAIL_USD"), optimization.includes("storeEmails * PER_EMAIL")], [true, false]);

done();
