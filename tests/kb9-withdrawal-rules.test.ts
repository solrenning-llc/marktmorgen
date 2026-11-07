/**
 * The EU withdrawal function's rules (queue item 588 [KB9], unit 1a, added
 * 6 November 2026; Directive 2011/83/EU art. 11a as inserted by Directive (EU)
 * 2023/2673, read in docs/kb9-eu-withdrawal-2026-11-06.md): lib/withdrawal-rules.ts.
 *
 * Checked:
 *
 *   - when the function is offered for an order: 14 days from the contract;
 *     digital content whose buyer gave the art. 16(m) yes ends when supply
 *     begins; a pre-order not yet handed over keeps the 14 days, whatever
 *     its planned day (only real supply ends it); a membership, 14 days; an
 *     order brought over or given by the creator, never; a shipped item, until
 *     its receipt is known; an unknown time never closes it early;
 *   - the statement carries the name, the order and the email for the
 *     confirmation, each checked, nothing else;
 *   - the acknowledgement quotes the statement's content and the date and
 *     time it was submitted (art. 11a(4));
 *   - a statement submitted before the period ended counts (art. 11a(5)).
 */
import {
  CONFIRM_WITHDRAWAL,
  WITHDRAW_FROM_CONTRACT,
  WITHDRAWAL_DAYS,
  acknowledgement,
  readStatement,
  submittedInTime,
  withdrawalWindow,
} from "@/lib/withdrawal-rules";
import { done, is, part } from "./check";

const DAY = 86_400;
const PAID = 1_790_000_000;
const consent = (kind: "digital" | "membership", at = PAID - 60) => ({ version: "2026-10-30.2", at, kind });
// The period's end for PAID (Monday September 21, 2026, 14:13:20 UTC, already Tuesday September 22 at UTC+14, the latest
// calendar day anywhere): day 14 is Tuesday October 6, open to its end anywhere on Earth, 11:59:59 UTC on October 7
// (lib/withdrawal-rules.ts, withdrawalEnd; Claude 5 on #2827 and its focal return). Counted here by hand.
const END = Date.UTC(2026, 9, 7, 11, 59, 59) / 1000;
const sale = (over: Partial<Parameters<typeof withdrawalWindow>[0]> = {}) => ({ kind: "sale" as const, paidAt: PAID, member: false, givenByStore: false, consent: null, ...over });

part("The words the law names");
is("the function's label", WITHDRAW_FROM_CONTRACT, "Withdraw from contract here");
is("the confirmation's label", CONFIRM_WITHDRAWAL, "Confirm withdrawal");
is("fourteen days", WITHDRAWAL_DAYS, 14);

part("When it is offered");
is("digital content without the yes: open for 14 days from the contract", withdrawalWindow(sale(), PAID + DAY), { open: true, until: END });
is("and closed after them", withdrawalWindow(sale(), END + 1), { open: false, why: "ended" });
is("digital content with the yes, handed over at once, its confirmation sent: never offered", withdrawalWindow(sale({ consent: consent("digital"), confirmed: true }), PAID + 60), { open: false, why: "supplied" });
is("a membership: 14 days, whatever the yes says (a service, lost only once fully performed)", withdrawalWindow(sale({ member: true, consent: consent("membership") }), PAID + 3 * DAY), { open: true, until: END });
is("a membership's yes alone marks it as one", withdrawalWindow(sale({ consent: consent("membership") }), PAID + DAY), { open: true, until: END });
is("a pre-order with the yes, release in 5 days: the 14 days, its planned day is not supply", withdrawalWindow(sale({ consent: consent("digital"), preorder: { day: "2026-09-26", given: false } }), PAID + DAY), { open: true, until: END });
is("still not handed over after its planned day: still open", withdrawalWindow(sale({ consent: consent("digital"), preorder: { day: "2026-09-26", given: false } }), PAID + 10 * DAY), { open: true, until: END });
is("a pre-order whose release is after the 14 days: the 14 days", withdrawalWindow(sale({ consent: consent("digital"), preorder: { day: "2027-03-01", given: false } }), PAID + DAY), { open: true, until: END });
is("a pre-order with no day set yet: the 14 days", withdrawalWindow(sale({ consent: consent("digital"), preorder: { day: null, given: false } }), PAID + DAY), { open: true, until: END });
is("a pre-order already handed over, with the yes and its confirmation sent: closed", withdrawalWindow(sale({ consent: consent("digital"), preorder: { day: "2026-09-26", given: true }, confirmed: true }), PAID + 2 * DAY), { open: false, why: "supplied" });
is("a pre-order with a day that does not read: the 14 days, never shorter", withdrawalWindow(sale({ consent: consent("digital"), preorder: { day: "soon", given: false } }), PAID + DAY), { open: true, until: END });
is("a shipped item: open while its receipt is not known", withdrawalWindow(sale({ shipped: true }), PAID + 20 * DAY), { open: true, until: null });
is("received on day 70, still open on day 80 (14 days from receipt, art. 9(2)(b))", withdrawalWindow(sale({ shipped: true }), PAID + 80 * DAY), { open: true, until: null });
is("a shipped item's yes does not close it (it keeps its own right)", withdrawalWindow(sale({ shipped: true, consent: consent("digital") }), PAID + DAY).open, true);
is("brought over from another platform: not offered", withdrawalWindow(sale({ kind: "imported" }), PAID + DAY), { open: false, why: "not-here" });
is("given by the creator's tools, no payment: not offered", withdrawalWindow(sale({ givenByStore: true }), PAID + DAY), { open: false, why: "not-here" });
is("an offer added after paying is its own contract: the same rules", withdrawalWindow(sale({ kind: "upsell" }), PAID + DAY), { open: true, until: END });
is("an unknown payment time is never read as closed", withdrawalWindow(sale({ paidAt: 0 }), PAID + DAY), { open: true, until: null });
is("nor a time that is not a whole second", withdrawalWindow(sale({ paidAt: Number.NaN }), PAID + DAY), { open: true, until: null });

part("Submitted in time (art. 11a(5))");
is("before the period ended: in time", submittedInTime({ open: true, until: PAID + 14 * DAY }, PAID + 14 * DAY), true);
is("after: not", submittedInTime({ open: true, until: PAID + 14 * DAY }, PAID + 14 * DAY + 1), false);
is("an unknown end: in time", submittedInTime({ open: true, until: null }, PAID + 400 * DAY), true);
is("a closed window: not", submittedInTime({ open: false, why: "supplied" }, PAID), false);

part("The statement");
const good = readStatement({ name: "  Ana Souza ", reference: "cs_test_a1b2c3", email: "Ana@Example.com " });
is("name, order and email, trimmed", good, { name: "Ana Souza", reference: "cs_test_a1b2c3", email: "ana@example.com" });
is("a name is needed", readStatement({ name: " ", reference: "cs_test_a1b2c3", email: "ana@example.com" }), null);
is("a name of at most 200 characters", readStatement({ name: "a".repeat(201), reference: "cs_test_a1b2c3", email: "ana@example.com" }), null);
is("an email that reads as one", readStatement({ name: "Ana", reference: "cs_test_a1b2c3", email: "not an email" }), null);
is("an order reference that reads as one", readStatement({ name: "Ana", reference: "../etc", email: "ana@example.com" }), null);
is("nothing else is kept", Object.keys(readStatement({ name: "Ana", reference: "cs_test_a1b2c3", email: "ana@example.com", note: "extra" }) ?? {}).sort(), ["email", "name", "reference"]);
is("anything not text is refused", readStatement({ name: 7, reference: "cs_test_a1b2c3", email: "ana@example.com" }), null);

part("The acknowledgement (art. 11a(4))");
const ack = acknowledgement({ name: "Ana Souza", reference: "cs_test_a1b2c3", email: "ana@example.com" }, "The Butter Course", "Mara's Kitchen", Date.UTC(2026, 10, 6, 18, 5, 9));
is("it says the withdrawal was received", ack.subject.includes("withdrawal") && ack.text.includes("received your withdrawal"), true);
is("it quotes the content: name, order, product and email", ["Ana Souza", "cs_test_a1b2c3", "The Butter Course", "ana@example.com"].every((part) => ack.text.includes(part)), true);
is("with the date and time of submission, in UTC", ack.text.includes("November 6, 2026 at 18:05:09 UTC"), true);
is("and who receives it", ack.text.includes("Mara's Kitchen"), true);
is("it promises nothing about the money it cannot keep (the refund is the creator's)", /we will refund|refunded within|guarantee/i.test(ack.text), false);

done();
