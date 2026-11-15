/**
 * A balance transaction weighs a closing refund only when it is the charge's own (#4727, Codex X8). settledCost
 * read the amount and currency of whatever expanded balance transaction came back, so one whose `source` named
 * another charge, or none, set the cost of the refund in another payment's terms: the refund could be left short on
 * the last closing day, or started without its coverage confirmed. An expanded transaction now counts only when its
 * `source` is this charge's id; otherwise the member is tried again. An explicit `balance_transaction: null` keeps
 * the charge's own currency, as before. Pure function; synthetic charges.
 */
import { settledCost } from "@/lib/closing-refunds";
import { done, is, part } from "./check";

function threw(f: () => unknown): boolean {
  try {
    f();
    return false;
  } catch {
    return true;
  }
}

async function main(): Promise<void> {
  const base = { id: "ch_fixture", amount: 1000, currency: "usd" };
  part("A balance transaction that is not this charge's never sets the cost");
  is("a source that is another charge: refused", threw(() => settledCost(500, { ...base, balance_transaction: { amount: 900, currency: "eur", source: "ch_unrelated" } })), true);
  is("no source: refused", threw(() => settledCost(500, { ...base, balance_transaction: { amount: 900, currency: "eur" } })), true);
  is("a charge with no id: refused", threw(() => settledCost(500, { amount: 1000, currency: "usd", balance_transaction: { amount: 900, currency: "eur", source: "ch_fixture" } })), true);

  part("This charge's own transaction, or none, as before");
  is("its own source, as an id: read", settledCost(500, { ...base, balance_transaction: { amount: 900, currency: "eur", source: "ch_fixture" } }), { cur: "eur", amount: 450 });
  is("its own source, expanded: read", settledCost(500, { ...base, balance_transaction: { amount: 900, currency: "eur", source: { id: "ch_fixture" } } }), { cur: "eur", amount: 450 });
  is("a null transaction keeps the charge's currency", settledCost(500, { ...base, balance_transaction: null }), { cur: "usd", amount: 500 });

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
