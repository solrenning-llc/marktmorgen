/**
 * 444 [TS2] unit 1 (docs/plan-test-subscribe.md): the one decision on whether
 * a creator may open a plan checkout in Stripe's test mode, and with which key.
 * It opens only when every condition holds: the switch is on (TS1's
 * STORE_TEST_MODE_ON, passed by the caller), the store is in test mode (read
 * as a boolean, unknown refuses), the choice is a plan and an interval of
 * lib/plan.ts, the test key is a test key, and the live platform key is a
 * live key, so no reader signed with the live key can ever see what the test
 * checkout makes. It never opens a real subscription, never reads or changes
 * PLANS_ON_SALE or any gate, and asks nothing of Stripe or Redis. Synthetic
 * keys only.
 */
import { PLAN_TEST_KEY_ENV, decidePlanTestCheckout, planTestKey } from "@/lib/plan-test-checkout";
import { PLANS_ON_SALE } from "@/lib/opening";
import { TIERS } from "@/lib/plan";
import { done, is, part } from "./check";

const LIVE = "sk_live_fixturelive";
const TEST = "sk_test_fixturetest";

function keys(test: string | undefined, live: string | undefined): void {
  if (test === undefined) delete process.env[PLAN_TEST_KEY_ENV];
  else process.env[PLAN_TEST_KEY_ENV] = test;
  if (live === undefined) delete process.env.STRIPE_SECRET_KEY;
  else process.env.STRIPE_SECRET_KEY = live;
}

const open = { switchOn: true, storeInTestMode: true, tier: "creator", cycle: "month" } as const;

part("the test key: only a test key, from one place");
is("the variable it reads", PLAN_TEST_KEY_ENV, "STRIPE_TEST_SECRET_KEY");
keys(TEST, LIVE);
is("a secret test key is taken", planTestKey(), TEST);
keys("rk_test_fixturerestricted", LIVE);
is("a restricted test key is taken", planTestKey(), "rk_test_fixturerestricted");
keys(`  ${TEST}\n`, LIVE);
is("surrounding spaces are trimmed", planTestKey(), TEST);
for (const bad of [LIVE, "rk_live_fixturelive", "pk_test_fixturepublishable", "sk_test", "test", "", "   "]) {
  keys(bad, LIVE);
  is(`refused: ${JSON.stringify(bad)}`, planTestKey(), null);
}
keys(undefined, LIVE);
is("none set: none", planTestKey(), null);
keys(undefined, undefined);
process.env.STRIPE_DEMO_SECRET_KEY = "sk_test_fixturedemo";
is("the demo's key is not taken in its place (the owner decides)", planTestKey(), null);
delete process.env.STRIPE_DEMO_SECRET_KEY;

part("every plan and interval opens in test mode, signed with the test key only");
keys(TEST, LIVE);
for (const tier of TIERS) {
  for (const cycle of ["month", "year"] as const) {
    const decision = decidePlanTestCheckout({ ...open, tier, cycle });
    is(`${tier} ${cycle}`, decision, { open: true, mode: "test", key: TEST, tier, cycle });
    is(`${tier} ${cycle}: never the live key`, decision.open && decision.key === LIVE, false);
  }
}

part("each condition alone refuses, with its reason");
keys(TEST, LIVE);
is("switch off", decidePlanTestCheckout({ ...open, switchOn: false }), { open: false, reason: "switch-off" });
is("store not in test mode", decidePlanTestCheckout({ ...open, storeInTestMode: false }), { open: false, reason: "store-not-in-test" });
is("store's mode unknown", decidePlanTestCheckout({ ...open, storeInTestMode: null }), { open: false, reason: "store-mode-unknown" });
for (const tier of ["", "Creator", "studio", "free", undefined, null, 1]) {
  is(`plan ${JSON.stringify(tier)}`, decidePlanTestCheckout({ ...open, tier }), { open: false, reason: "choice" });
}
for (const cycle of ["", "monthly", "week", undefined, null, 12]) {
  is(`interval ${JSON.stringify(cycle)}`, decidePlanTestCheckout({ ...open, cycle }), { open: false, reason: "choice" });
}
keys(undefined, LIVE);
is("no test key", decidePlanTestCheckout(open), { open: false, reason: "no-test-key" });
keys(LIVE, LIVE);
is("a live key where the test key goes", decidePlanTestCheckout(open), { open: false, reason: "no-test-key" });
keys(TEST, TEST);
is("the site itself on a test key: modes not apart", decidePlanTestCheckout(open), { open: false, reason: "modes-not-apart" });
keys(TEST, "sk_test_fixtureother");
is("the site on another test key: modes not apart", decidePlanTestCheckout(open), { open: false, reason: "modes-not-apart" });
keys(TEST, undefined);
is("no live key: modes not proven apart", decidePlanTestCheckout(open), { open: false, reason: "modes-not-apart" });
keys(TEST, "sk_live");
is("a malformed live key: modes not proven apart", decidePlanTestCheckout(open), { open: false, reason: "modes-not-apart" });
keys(TEST, "rk_live_fixturerestricted");
is("a restricted live key counts as live", decidePlanTestCheckout(open).open, true);

part("the first failing condition is the one said, switch first");
keys(undefined, TEST);
is("everything wrong: switch off", decidePlanTestCheckout({ switchOn: false, storeInTestMode: null, tier: "x", cycle: "y" }), { open: false, reason: "switch-off" });
is("switch on, rest wrong: the store's mode", decidePlanTestCheckout({ switchOn: true, storeInTestMode: null, tier: "x", cycle: "y" }), { open: false, reason: "store-mode-unknown" });

part("only a real true opens: truthy values are not true");
keys(TEST, LIVE);
is("switch 1", decidePlanTestCheckout({ ...open, switchOn: 1 as unknown as boolean }), { open: false, reason: "switch-off" });
is("store mode \"true\"", decidePlanTestCheckout({ ...open, storeInTestMode: "true" as unknown as boolean }), { open: false, reason: "store-mode-unknown" });

part("no gate is read or moved");
is("PLANS_ON_SALE stays false", PLANS_ON_SALE, false);

done();
