/**
 * A benefit's "given" mark, as the database answers it, fits BENEFIT_MARK_VALUE_BYTES (tests/plan-cost-registry.ts),
 * which prices every mark the benefits page reads (benefitsRead). lib/tier-benefits.ts giveBenefit keeps
 * `{"at":<seconds>,"by":"<address>"}` with the address cut to 320 characters, and the REST answer escapes that JSON
 * again: a control character or a lone surrogate is `\uXXXX` kept (6 bytes) and `\\uXXXX` answered (7 bytes), a quote
 * or a backslash 4 bytes answered, an ideogram 3. The figure counted 2 bytes a character and the fixed part unescaped,
 * so a mark could answer more than three times what it priced (Claude 1 coord's audit, 26th batch, 20261122T163155Z;
 * the same convention as CHECKOUT_TROUBLE_READ and BENEFIT_ROW_BYTES). Synthetic data only; nothing is stored.
 */
import { readFileSync } from "node:fs";
import { BENEFIT_MARK_VALUE_BYTES } from "./plan-cost-registry";
import { done, is, part } from "./check";

/** The address as giveBenefit cuts it. */
const ADDRESS_MOST = 320;
/** Seconds as `at`: eleven digits reach the year 5138. */
const AT_MOST = 99_999_999_999;
/** One character of each kind whose escaping costs the most, kept or answered. */
const KINDS: Record<string, string> = { control: "\u0001", "lone surrogate": "\ud800", quote: "\"", backslash: "\\", ideogram: "中", letter: "a" };

/** The bytes the database answers for a mark whose address is `ch` repeated: the kept JSON, escaped again. */
const answered = (ch: string) => Buffer.byteLength(JSON.stringify(JSON.stringify({ at: AT_MOST, by: ch.repeat(ADDRESS_MOST).slice(0, ADDRESS_MOST) })), "utf8");

part("The mark's shape is the one priced");
const source = readFileSync("lib/tier-benefits.ts", "utf8");
is("giveBenefit keeps { at, by } with the address cut to 320 characters", /const mark: Given = \{ at: Math\.floor\(now \/ 1000\), by: normaliseEmail\(by\)\.slice\(0, 320\) \};/.test(source), true);

part("Every kind of address character fits the figure, as the database answers it");
for (const [kind, ch] of Object.entries(KINDS)) {
  is(`${kind}: ${answered(ch)} bytes answered is within BENEFIT_MARK_VALUE_BYTES`, answered(ch) <= BENEFIT_MARK_VALUE_BYTES, true);
}
const worst = Math.max(...Object.values(KINDS).map(answered));
is("the figure is the worst kind exactly, no more than needed", BENEFIT_MARK_VALUE_BYTES, worst);

done();
