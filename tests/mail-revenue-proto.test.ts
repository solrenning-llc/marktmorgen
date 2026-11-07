/**
 * A campaign tag is chosen by whoever opens a store link (utm_campaign), and lib/came-from.ts keeps
 * [a-z0-9._-], so "__proto__", "constructor" and "prototype" all reach moneyByCampaign. Adding them up on
 * a plain object wrote onto Object.prototype for the whole server process (independent review by Claude 4's
 * reviewer of #2798; proof rev4-mail-proto). Every tag must stay an own key of the result and nothing else.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { broadcastMoney, moneyByCampaign } from "@/lib/mail-revenue";

for (const tag of ["__proto__", "constructor", "prototype", "hasOwnProperty", "toString"]) {
  test(`a sale tagged "${tag}" is counted as that email and touches no shared prototype`, () => {
    const by = moneyByCampaign([
      { source: "email", campaign: tag, cents: 1900, currency: "eur" },
      { source: "email", campaign: tag, cents: 100, currency: "usd" },
    ], "eur");
    assert.equal(({} as Record<string, unknown>).sales, undefined);
    assert.equal(({} as Record<string, unknown>).cents, undefined);
    assert.equal(({} as Record<string, unknown>).elsewhere, undefined);
    assert.deepEqual(Object.keys(by), [tag]);
    assert.deepEqual({ ...by[tag] }, { sales: 1, cents: 1900, elsewhere: 1 });
  });
}

test("an ordinary tag still adds up, and an untagged or other-source sale is left out", () => {
  const by = moneyByCampaign([
    { source: "email", campaign: "bc-1", cents: 500, currency: "eur" },
    { source: "email", campaign: "bc-1", cents: 700, currency: "eur" },
    { source: "email", campaign: "", cents: 900, currency: "eur" },
    { source: "ads", campaign: "bc-1", cents: 900, currency: "eur" },
  ], "eur");
  assert.deepEqual(Object.keys(by), ["bc-1"]);
  assert.deepEqual({ ...by["bc-1"] }, { sales: 2, cents: 1200 });
});

test("an email whose tag is a prototype name reads only its own sales", () => {
  const by = moneyByCampaign([], "eur");
  assert.equal(broadcastMoney({ by, partial: false } as never, "constructor"), null);
});
