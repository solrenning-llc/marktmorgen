"""The mixed-integer program of docs/pricing-optimization-2026-10-18.md.

Reads docs/pricing-optimization-milp-input-2026-10-18.json (written by
tests/pricing-optimization-table.ts milpInput(), every coefficient from the
repository's own margin code) and writes
docs/pricing-optimization-milp-output-2026-10-18.json: for each demand
scenario and alternative, each plan's monthly price and the share of each
#553 figure. tests/pricing-optimization.test.ts checks every solution again
with the repository's code and against an exhaustive search.

Every room and alternative A's feasibility come from the input, so the
program holds each plan to the floor the table holds it to: since 7 November
2026 the MR rule (AGENTS.md), a net profit greater than zero with the spend
floor's room on both intervals, no longer 60%.

    python3 scripts/pricing-optimization-milp.py

Needs numpy and scipy (scipy.optimize.milp, the HiGHS solver).
"""
import json
import pathlib
import sys

import numpy as np
import scipy
from scipy.optimize import Bounds, LinearConstraint, milp

ROOT = pathlib.Path(__file__).resolve().parent.parent
INPUT = ROOT / "docs/pricing-optimization-milp-input-2026-10-18.json"
OUTPUT = ROOT / "docs/pricing-optimization-milp-output-2026-10-18.json"


def solve(data, scenario, alternative):
    tiers, printed = data["tiers"], data["printed"]
    lower = data["alternatives"][alternative]
    kept = data["taxKeptBps"] / 10_000
    # Variable layout: for each tier and option, x (binary), then one share per printed figure.
    index, n = {}, 0
    for t in tiers:
        for j, _ in enumerate(data["plans"][t]["options"]):
            index[(t, j, "x")] = n
            n += 1
            for r in printed:
                index[(t, j, r)] = n
                n += 1
    c = np.zeros(n)
    lb, ub, integrality = np.zeros(n), np.ones(n), np.zeros(n)
    rows, lo, hi = [], [], []

    def add(coeffs, low, high):
        row = np.zeros(n)
        for k, v in coeffs.items():
            row[k] += v
        rows.append(row)
        lo.append(low)
        hi.append(high)

    for t in tiers:
        plan = data["plans"][t]
        opts = plan["options"]
        add({index[(t, j, "x")]: 1 for j in range(len(opts))}, 1, 1)
        for j, o in enumerate(opts):
            x = index[(t, j, "x")]
            integrality[x] = 1
            q = o["demand"][scenario]
            # Profit: q times the net at today's figures, plus what lower usage leaves after the profit tax.
            # Fixed full-use A has exact repository feasibility/profit, without linear rounding.
            fixed = alternative == "A"
            if fixed:
                ub[x] = 1 if o["exactKeepsAtOnes"] is True else 0
                c[x] -= q * o["netAtOnes"] / 100
            else:
                c[x] -= q * (o["netAtOnes"] + kept * sum(plan["coefMonth"][r] for r in printed)) / 100
            for r in printed:
                s = index[(t, j, r)]
                if not fixed:
                    c[s] += q * kept * plan["coefMonth"][r] / 100
                share_floor = lower if plan["figures"][r] > 0 else 1
                # share_floor * x <= s <= x
                add({s: 1, x: -share_floor}, 0, np.inf)
                add({s: 1, x: -1}, -np.inf, 0)
            for cycle in (() if fixed else ("Month", "Year")):
                coeffs = {x: plan["base" + cycle] - o["room" + cycle]}
                for r in printed:
                    coeffs[index[(t, j, r)]] = plan["coef" + cycle][r]
                add(coeffs, -np.inf, 0)
    for a, b in zip(tiers, tiers[1:]):
        # Prices rise by at least $10 from one plan to the next.
        coeffs = {index[(a, j, "x")]: o["monthCents"] for j, o in enumerate(data["plans"][a]["options"])}
        for j, o in enumerate(data["plans"][b]["options"]):
            coeffs[index[(b, j, "x")]] = coeffs.get(index[(b, j, "x")], 0) - o["monthCents"]
        add(coeffs, -np.inf, -1000)
        # No figure is above the same figure of the plan above.
        for r in printed:
            fa, fb = data["plans"][a]["figures"][r], data["plans"][b]["figures"][r]
            if fa > 0 and fb > 0:
                coeffs = {index[(a, j, r)]: fa for j in range(len(data["plans"][a]["options"]))}
                for j in range(len(data["plans"][b]["options"])):
                    coeffs[index[(b, j, r)]] = -fb
                add(coeffs, -np.inf, 0)
    result = milp(c, constraints=LinearConstraint(np.array(rows), lo, hi), integrality=integrality, bounds=Bounds(lb, ub), options={"disp": False})
    plans = {}
    if result.x is not None:
        for t in tiers:
            for j, o in enumerate(data["plans"][t]["options"]):
                if result.x[index[(t, j, "x")]] > 0.5:
                    plans[t] = {"monthCents": o["monthCents"], "shares": {r: round(float(result.x[index[(t, j, r)]]), 6) for r in printed}}
    return {"scenario": scenario, "alternative": alternative, "status": result.message, "objective": None if result.fun is None else round(-float(result.fun), 4), "plans": plans}


def main():
    data = json.loads(INPUT.read_text())
    solutions = [solve(data, str(e) if e != int(e) else str(int(e)), alt) for e in data["elasticities"] for alt in data["alternatives"]]
    out = {"solver": f"scipy.optimize.milp (HiGHS), scipy {scipy.__version__.split('.')[0]}.x", "solutions": solutions}
    OUTPUT.write_text(json.dumps(out, indent=1) + "\n")
    print(f"Wrote {OUTPUT}")
    if any(not s["plans"] for s in solutions):
        sys.exit("a scenario had no solution")


if __name__ == "__main__":
    main()
