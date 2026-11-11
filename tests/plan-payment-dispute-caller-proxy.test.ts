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
    assert.equal(reads, 0, "the funding boundary must reject the Proxy without traps");
  });
}

for (const change of ["disputes-reference", "review-reference", "review-prototype", "final-identity-scan"] as const) {
  test(`final observation cannot change unchecked original ${change}`, () => {
    const fixture = contractFixture();
    assert.ok(contractFundingConfiguration(fixture.policy, fixture.context, fixture.now));
    let visits = 0;
    let installed = 0;
    let gets = 0;
    const unknownDisputes = () => new Proxy(
      { ...fixture.review.planPaymentDisputes, unreviewedPlan: null },
      {
        ownKeys: (target) =>
          Reflect.ownKeys(target).filter((key) => key !== "unreviewedPlan"),
        get() {
          gets++;
          throw new Error("must not execute ordinary reads");
        },
      },
    );
    let context = fixture.context;
    if (change === "final-identity-scan") {
      context = {
        ...fixture.context,
        review: new Proxy(fixture.review, {
          getOwnPropertyDescriptor(target, key) {
            const descriptor = Reflect.getOwnPropertyDescriptor(target, key);
            if (key === "scenarios" && ++visits === 3) {
              installed++;
              fixture.review.planPaymentDisputes = unknownDisputes();
            }
            return descriptor;
          },
        }),
      };
    } else {
      fixture.review.scenarios = new Proxy(fixture.review.scenarios, {
        getOwnPropertyDescriptor(target, key) {
          if (key === "review" && ++visits === 3) {
            installed++;
            if (change === "disputes-reference") {
              fixture.review.planPaymentDisputes = unknownDisputes();
            } else if (change === "review-reference") {
              fixture.context.review = {
                ...fixture.review,
                planPaymentDisputes: unknownDisputes(),
              };
            } else {
              Object.setPrototypeOf(fixture.review, { unreviewedLiability: null });
            }
          }
          return Reflect.getOwnPropertyDescriptor(target, key);
        },
      });
    }

    const actual = contractFundingConfiguration(fixture.policy, context, fixture.now);
    assert.equal(visits, 0, "Proxy detection must precede descriptor observation");
    assert.equal(installed, 0, "no late mutation callback may run");
    assert.equal(gets, 0, "validation must not execute ordinary Proxy reads");
    assert.equal(actual, null, "executable evidence must fail closed before observation");
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
      assert.equal(reads, 0, "the entry point must reject the wrapper without traps");
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
  assert.equal(installed, 0, "Proxy rejection must precede the late getter callback");
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
  assert.equal(mutations, 0, "Proxy rejection must precede the mutation callback");
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
    assert.equal(installs, 0, "Proxy rejection must precede hidden-liability insertion");
    assert.equal(reads, 0, "Proxy rejection must not execute context descriptor traps");
    assert.equal(
      actual,
      null,
      "executable evidence must be rejected before it can alter the graph",
    );
  });
}

for (const inherited of ["data", "getter"] as const) {
  test(`missing own dispute evidence cannot use inherited ${inherited}`, () => {
    const fixture = contractFixture();
    assert.ok(contractFundingConfiguration(fixture.policy, fixture.context, fixture.now));
    const disputes = fixture.review.planPaymentDisputes!;
    delete fixture.review.planPaymentDisputes;
    fixture.policy.financialSnapshot = canonicalFinancialSnapshot(fixture.review)!;
    assert.equal(Object.hasOwn(fixture.review, "planPaymentDisputes"), false);

    let reads = 0;
    let actual: ReturnType<typeof contractFundingConfiguration>;
    const previous = Object.getOwnPropertyDescriptor(Object.prototype, "planPaymentDisputes");
    try {
      Object.defineProperty(
        Object.prototype,
        "planPaymentDisputes",
        inherited === "getter"
          ? { configurable: true, get() { reads++; return disputes; } }
          : { configurable: true, value: disputes },
      );
      actual = contractFundingConfiguration(fixture.policy, fixture.context, fixture.now);
    } finally {
      if (previous) {
        Object.defineProperty(Object.prototype, "planPaymentDisputes", previous);
      } else {
        Reflect.deleteProperty(Object.prototype, "planPaymentDisputes");
      }
    }

    assert.equal(reads, 0, "funding validation must not invoke inherited evidence getters");
    assert.equal(actual, null, "required dispute evidence must be own enumerable data");
  });
}

for (const inherited of ["data", "getter"] as const) {
  test(`missing own reserved funds cannot use inherited ${inherited}`, () => {
    const fixture = contractFixture();
    assert.ok(contractFundingConfiguration(fixture.policy, fixture.context, fixture.now));
    const funds = fixture.policy.reservedFundsCents;
    delete (fixture.policy as Partial<typeof fixture.policy>).reservedFundsCents;

    let reads = 0;
    let actual: ReturnType<typeof contractFundingConfiguration>;
    const previous = Object.getOwnPropertyDescriptor(Object.prototype, "reservedFundsCents");
    try {
      Object.defineProperty(
        Object.prototype,
        "reservedFundsCents",
        inherited === "getter"
          ? { configurable: true, get() { reads++; return funds; } }
          : { configurable: true, value: funds },
      );
      actual = contractFundingConfiguration(fixture.policy, fixture.context, fixture.now);
    } finally {
      if (previous) {
        Object.defineProperty(Object.prototype, "reservedFundsCents", previous);
      } else {
        Reflect.deleteProperty(Object.prototype, "reservedFundsCents");
      }
    }

    assert.equal(reads, 0, "funding validation must not invoke inherited policy getters");
    assert.equal(actual, null, "required policy money must be own data in the snapshot");
  });
}

for (const kind of ["getter", "proxy"] as const) {
  test(`clock ${kind} cannot mutate an admitted funding graph`, () => {
    const fixture = contractFixture();
    assert.ok(contractFundingConfiguration(fixture.policy, fixture.context, fixture.now));
    const at = Date.prototype.getTime.call(fixture.now);
    let reads = 0;
    const getTime = () => {
      reads++;
      if (reads === 1) {
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
      }
      return () => at;
    };
    const now = kind === "getter"
      ? Object.defineProperty(new Date(at), "getTime", { configurable: true, get: getTime })
      : new Proxy(new Date(at), {
          get(target, key, receiver) {
            return key === "getTime" ? getTime() : Reflect.get(target, key, receiver);
          },
        });

    const actual = contractFundingConfiguration(fixture.policy, fixture.context, now);
    assert.equal(reads, 0, "clock validation must not invoke supplied getters or traps");
    assert.equal(actual, null, "an executable clock must fail closed without throwing");
  });
}

for (const boundary of ["context", "review"] as const) {
  test(`capture does not normalize an unsupported ${boundary} prototype`, () => {
    const fixture = contractFixture();
    assert.ok(contractFundingConfiguration(fixture.policy, fixture.context, fixture.now));
    Object.setPrototypeOf(
      boundary === "context" ? fixture.context : fixture.review,
      { unreviewedLiability: null },
    );
    assert.equal(
      canonicalFinancialSnapshot(fixture.context),
      null,
      "the original graph is unsupported at the canonical boundary",
    );
    assert.equal(
      contractFundingConfiguration(fixture.policy, fixture.context, fixture.now),
      null,
      "capture must not normalize inherited unknown evidence into a plain record",
    );
  });
}
