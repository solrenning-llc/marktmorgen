import assert from "node:assert/strict";
import test from "node:test";
import { contractFixture } from "./contract-funding-fixture";
import {
  canonicalFinancialSnapshot,
  contractFundingConfiguration,
} from "@/lib/contract-funding-rules";
import { assessPlanPaymentDisputeCosts } from "@/lib/plan-payment-dispute-cost-rules";

for (const boundary of ["outer", "row"] as const) {
  test(`the funding boundary rejects an original ${boundary} dispute Proxy before projection`, () => {
    const fixture = contractFixture();
    assert.ok(contractFundingConfiguration(fixture.policy, fixture.context, fixture.now));

    if (boundary === "outer") {
      fixture.review.planPaymentDisputes = new Proxy(
        { ...fixture.review.planPaymentDisputes, unreviewedPlan: null },
        {
          ownKeys: (target) => Reflect.ownKeys(target).filter((key) => key !== "unreviewedPlan"),
        },
      );
    } else {
      fixture.review.planPaymentDisputes!.creator_year = new Proxy(
        {
          ...fixture.review.planPaymentDisputes!.creator_year!,
          additionalFeesCents: null,
        },
        {
          ownKeys: (target) => Reflect.ownKeys(target).filter((key) => key !== "additionalFeesCents"),
        },
      );
    }

    assert.equal(assessPlanPaymentDisputeCosts(fixture.review.planPaymentDisputes), null);
    assert.equal(
      canonicalFinancialSnapshot(fixture.review),
      fixture.policy.financialSnapshot,
      "the former financial binding still matches the projected evidence",
    );
    assert.equal(
      contractFundingConfiguration(fixture.policy, fixture.context, fixture.now),
      null,
      "the funding boundary must not approve evidence rejected at the direct boundary",
    );
  });
}

for (const boundary of ["context", "review"] as const) {
  test(`the captured dispute assessment matches the ${boundary} review bound after projection`, () => {
    const fixture = contractFixture();
    const baseline = contractFundingConfiguration(fixture.policy, fixture.context, fixture.now);
    assert.ok(baseline);

    const original = fixture.review;
    const later = structuredClone(fixture.review);
    later.planPaymentDisputes!.creator_year!.maximumPaidPrincipalCents! += 100;
    fixture.policy.financialSnapshot = canonicalFinancialSnapshot(later)!;
    assert.equal(
      contractFundingConfiguration(
        fixture.policy,
        { ...fixture.context, review: later },
        fixture.now,
      ),
      null,
      "the larger plain liability does not fit the previously reserved cash",
    );
    const fullyFunded = contractFundingConfiguration(
      { ...fixture.policy, reservedFundsCents: fixture.policy.reservedFundsCents + 200 },
      { ...fixture.context, review: later },
      fixture.now,
    );
    assert.ok(fullyFunded);
    assert.equal(fullyFunded.grantCents.creator_year, baseline.grantCents.creator_year + 100);

    let reads = 0;
    const context = boundary === "context"
      ? new Proxy(fixture.context, {
          getOwnPropertyDescriptor(target, key) {
            const descriptor = Reflect.getOwnPropertyDescriptor(target, key);
            return key === "review" && descriptor
              ? { ...descriptor, value: ++reads === 1 ? original : later }
              : descriptor;
          },
        })
      : {
          ...fixture.context,
          review: new Proxy(fixture.review, {
            getOwnPropertyDescriptor(target, key) {
              const descriptor = Reflect.getOwnPropertyDescriptor(target, key);
              return key === "planPaymentDisputes" && descriptor
                ? {
                    ...descriptor,
                    value: ++reads === 1
                      ? original.planPaymentDisputes
                      : later.planPaymentDisputes,
                  }
                : descriptor;
            },
          }),
        };
    assert.equal(
      contractFundingConfiguration(fixture.policy, context, fixture.now),
      null,
      "a later bound liability cannot use an earlier smaller assessment",
    );
    assert.ok(reads > 1, "the regression exercises distinct boundary captures");
  });
}

for (const wrapper of ["context", "review"] as const) {
  for (const hidden of ["outer", "row"] as const) {
    test(`${wrapper} wrapper cannot replace validated evidence with a hidden ${hidden} liability`, () => {
      const fixture = contractFixture();
      const original = fixture.review;
      const later = structuredClone(original);

      if (hidden === "outer") {
        later.planPaymentDisputes = new Proxy(
          { ...later.planPaymentDisputes, unreviewedPlan: null },
          {
            ownKeys: (target) =>
              Reflect.ownKeys(target).filter((key) => key !== "unreviewedPlan"),
          },
        );
      } else {
        later.planPaymentDisputes!.creator_year = new Proxy(
          {
            ...later.planPaymentDisputes!.creator_year!,
            additionalFeesCents: null,
          },
          {
            ownKeys: (target) =>
              Reflect.ownKeys(target).filter((key) => key !== "additionalFeesCents"),
          },
        );
      }

      assert.equal(
        assessPlanPaymentDisputeCosts(later.planPaymentDisputes),
        null,
        "the actual later evidence is unknown at the direct boundary",
      );
      assert.equal(
        canonicalFinancialSnapshot(later),
        fixture.policy.financialSnapshot,
        "projection discards the concealed liability without changing known totals",
      );

      let reads = 0;
      const context = wrapper === "context"
        ? new Proxy(fixture.context, {
            getOwnPropertyDescriptor(target, key) {
              const descriptor = Reflect.getOwnPropertyDescriptor(target, key);
              return key === "review" && descriptor
                ? { ...descriptor, value: ++reads === 1 ? original : later }
                : descriptor;
            },
          })
        : {
            ...fixture.context,
            review: new Proxy(fixture.review, {
              getOwnPropertyDescriptor(target, key) {
                const descriptor = Reflect.getOwnPropertyDescriptor(target, key);
                return key === "planPaymentDisputes" && descriptor
                  ? {
                      ...descriptor,
                      value: ++reads === 1
                        ? original.planPaymentDisputes
                        : later.planPaymentDisputes,
                    }
                  : descriptor;
              },
            }),
          };

      assert.equal(
        contractFundingConfiguration(fixture.policy, context, fixture.now),
        null,
        "matching projected numeric totals cannot approve substituted unknown evidence",
      );
      assert.ok(reads > 1, "the entry point observes distinct original references");
    });
  }
}

test("parent validation never executes a getter installed by a later scenario Proxy", () => {
  const fixture = contractFixture();
  assert.ok(contractFundingConfiguration(fixture.policy, fixture.context, fixture.now));

  let reads = 0;
  let installed = 0;
  fixture.review.scenarios = new Proxy(fixture.review.scenarios, {
    getOwnPropertyDescriptor(target, key) {
      if (key === "review") {
        installed++;
        Object.defineProperty(fixture.review.companyBase!, "fixedCostsEvidence", {
          configurable: true,
          enumerable: true,
          get() {
            reads++;
            throw new Error("must not execute a review getter");
          },
        });
      }
      return Reflect.getOwnPropertyDescriptor(target, key);
    },
  });

  assert.equal(
    contractFundingConfiguration(fixture.policy, fixture.context, fixture.now),
    null,
  );
  assert.equal(installed, 1, "the regression must install the late getter");
  assert.equal(reads, 0, "financial validation must not execute an original evidence getter");
});

test("post-serialization validation rejects a late plain evidence change", () => {
  const fixture = contractFixture();
  assert.ok(contractFundingConfiguration(fixture.policy, fixture.context, fixture.now));

  let mutations = 0;
  fixture.review.scenarios = new Proxy(fixture.review.scenarios, {
    getOwnPropertyDescriptor(target, key) {
      if (key === "review") {
        mutations++;
        fixture.review.companyBase!.fixedCostsEvidence = "CHANGED AFTER SERIALIZATION";
      }
      return Reflect.getOwnPropertyDescriptor(target, key);
    },
  });

  assert.equal(
    contractFundingConfiguration(fixture.policy, fixture.context, fixture.now),
    null,
    "a second valid snapshot cannot silently differ from the bound review",
  );
  assert.ok(mutations > 0, "the regression must change already serialized evidence");
});

for (const stage of ["review-ownKeys", "context-identity", "late-canonical"] as const) {
  test(`shallow capture cannot retain a hidden liability inserted at ${stage}`, () => {
    const fixture = contractFixture();
    assert.ok(contractFundingConfiguration(fixture.policy, fixture.context, fixture.now));
    let installs = 0;
    let reads = 0;
    const install = () => {
      if (installs++) return;
      fixture.review.planPaymentDisputes!.creator_year = new Proxy(
        {
          ...fixture.review.planPaymentDisputes!.creator_year!,
          additionalFeesCents: null,
        },
        {
          ownKeys: (target) =>
            Reflect.ownKeys(target).filter((key) => key !== "additionalFeesCents"),
        },
      );
    };

    let context: typeof fixture.context = fixture.context;
    if (stage === "review-ownKeys") {
      context = {
        ...fixture.context,
        review: new Proxy(fixture.review, {
          ownKeys(target) {
            install();
            return Reflect.ownKeys(target);
          },
        }),
      };
    } else if (stage === "context-identity") {
      context = new Proxy(fixture.context, {
        getOwnPropertyDescriptor(target, key) {
          const descriptor = Reflect.getOwnPropertyDescriptor(target, key);
          if (key === "review" && ++reads === 2) install();
          return descriptor;
        },
      });
    } else {
      fixture.review.scenarios = new Proxy(fixture.review.scenarios, {
        getOwnPropertyDescriptor(target, key) {
          if (key === "review") install();
          return Reflect.getOwnPropertyDescriptor(target, key);
        },
      });
    }

    const actual = contractFundingConfiguration(fixture.policy, context, fixture.now);
    assert.equal(
      assessPlanPaymentDisputeCosts(fixture.review.planPaymentDisputes),
      null,
      "the actual original graph now contains an unknown hidden liability",
    );
    assert.equal(
      actual,
      null,
      "captured evidence must remain complete after every executable observation",
    );
  });
}
