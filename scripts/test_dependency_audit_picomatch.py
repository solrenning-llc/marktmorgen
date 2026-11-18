"""The one dated development exception (GHSA-fc5q-39xc-vjpf, owner's decision C1-20261117-1513-c5c4c6-1) holds
only under every one of its conditions; each case below breaks exactly one and must refuse.

The findings mirror the real `npm audit --json` of main 1fcc549cda (17 November 2026): 14 high findings,
all reached only through picomatch's advisory, in the lint toolchain."""
import copy
import datetime
import unittest

from check_dependency_audit import ADVISORY, EXCEPTED, EXCEPTION_LAST_DAY, EXPIRED, review

NPM_FIX = {"name": "eslint-config-next", "version": "14.2.35", "isSemVerMajor": True}
CHAINS = {
    "@next/eslint-plugin-next": ["fast-glob"],
    "@typescript-eslint/eslint-plugin": ["@typescript-eslint/parser", "@typescript-eslint/type-utils", "@typescript-eslint/utils"],
    "@typescript-eslint/parser": ["@typescript-eslint/typescript-estree"],
    "@typescript-eslint/type-utils": ["@typescript-eslint/typescript-estree", "@typescript-eslint/utils"],
    "@typescript-eslint/typescript-estree": ["tinyglobby"],
    "@typescript-eslint/utils": ["@typescript-eslint/typescript-estree"],
    "eslint-config-next": ["@next/eslint-plugin-next", "typescript-eslint"],
    "eslint-import-resolver-typescript": ["tinyglobby"],
    "fast-glob": ["micromatch"],
    "fdir": ["picomatch"],
    "micromatch": ["picomatch"],
    "tinyglobby": ["fdir", "picomatch"],
    "typescript-eslint": ["@typescript-eslint/eslint-plugin", "@typescript-eslint/parser",
                          "@typescript-eslint/typescript-estree", "@typescript-eslint/utils"],
}
ADVISORY_CAUSE = {"source": 1247710, "name": "picomatch", "dependency": "picomatch",
                  "title": "picomatch vulnerable to ReDoS through single-branch repeated extglobs",
                  "url": ADVISORY, "severity": "high", "cwe": ["CWE-1333"], "range": "<=4.0.7"}
ON_THE_LAST_DAY = datetime.date(2026, 12, 1)


def report(values=None):
    values = values or {}
    return {"auditReportVersion": 2, "vulnerabilities": values, "metadata": {"vulnerabilities": {
        "high": sum(v["severity"] == "high" for v in values.values()),
        "critical": sum(v["severity"] == "critical" for v in values.values()),
    }}}


def lint_chain():
    values = {name: {"name": name, "severity": "high", "via": list(via), "fixAvailable": True}
              for name, via in CHAINS.items()}
    values["picomatch"] = {"name": "picomatch", "severity": "high", "via": [dict(ADVISORY_CAUSE)], "range": "*",
                           "nodes": ["node_modules/picomatch", "node_modules/tinyglobby/node_modules/picomatch"],
                           "fixAvailable": dict(NPM_FIX)}
    return values


def lock(extra=None):
    packages = {
        "": {"name": "nimbus-labs"},
        "node_modules/picomatch": {"version": "2.3.2", "dev": True},
        "node_modules/tinyglobby/node_modules/picomatch": {"version": "4.0.5", "dev": True},
        "node_modules/next": {"version": "16.4.5"},
        "node_modules/eslint-config-next": {"version": "16.4.5", "dev": True},
    }
    packages.update(extra or {})
    return {"lockfileVersion": 3, "packages": packages}


class PicomatchExceptionTests(unittest.TestCase):
    def test_this_advisory_alone_in_development_passes_until_the_last_day(self):
        for today in [datetime.date(2026, 11, 17), ON_THE_LAST_DAY]:
            self.assertEqual(review(report(lint_chain()), report(), lock(), today), sorted(EXCEPTED))
        self.assertEqual(len(EXCEPTED), 14)
        self.assertEqual(EXCEPTION_LAST_DAY, ON_THE_LAST_DAY)

    def test_the_day_after_it_refuses_as_the_owners_decision(self):
        with self.assertRaises(ValueError) as refused:
            review(report(lint_chain()), report(), lock(), datetime.date(2026, 12, 2))
        self.assertIn(EXPIRED, str(refused.exception))
        with self.assertRaises(ValueError):
            review(report(lint_chain()), report(), lock(), None)

    def test_another_advisory_in_development_refuses(self):
        values = lint_chain()
        other = dict(ADVISORY_CAUSE, url="https://github.com/advisories/GHSA-0000-0000-0000", source=1)
        values["picomatch"]["via"].append(other)
        with self.assertRaises(ValueError):
            review(report(values), report(), lock(), ON_THE_LAST_DAY)
        values = lint_chain()
        values["micromatch"]["via"] = [dict(ADVISORY_CAUSE, name="micromatch", dependency="micromatch")]
        with self.assertRaises(ValueError):
            review(report(values), report(), lock(), ON_THE_LAST_DAY)
        values = lint_chain()
        values["picomatch"]["via"] = [dict(ADVISORY_CAUSE, range="<=4.0.8")]
        with self.assertRaises(ValueError):
            review(report(values), report(), lock(), ON_THE_LAST_DAY)

    def test_this_advisory_in_production_refuses(self):
        production = {"picomatch": lint_chain()["picomatch"]}
        with self.assertRaises(ValueError) as refused:
            review(report(lint_chain()), report(production), lock(), ON_THE_LAST_DAY)
        self.assertIn("production", str(refused.exception))

    def test_picomatch_at_another_version_or_outside_development_refuses(self):
        for changed in [
            {"node_modules/tinyglobby/node_modules/picomatch": {"version": "4.0.6", "dev": True}},
            {"node_modules/picomatch": {"version": "2.3.2"}},
            {"node_modules/picomatch": {"version": "2.3.2", "dev": False}},
            {"node_modules/micromatch/node_modules/picomatch": {"version": "2.3.2", "dev": True}},
        ]:
            with self.assertRaises(ValueError):
                review(report(lint_chain()), report(), lock(changed), ON_THE_LAST_DAY)
        with self.assertRaises(ValueError):
            review(report(lint_chain()), report(), None, ON_THE_LAST_DAY)

    def test_a_fifteenth_package_refuses(self):
        values = lint_chain()
        values["glob-parent"] = {"name": "glob-parent", "severity": "high", "via": ["picomatch"], "fixAvailable": True}
        with self.assertRaises(ValueError):
            review(report(values), report(), lock(), ON_THE_LAST_DAY)

    def test_a_critical_finding_refuses(self):
        values = lint_chain()
        values["fdir"]["severity"] = "critical"
        with self.assertRaises(ValueError):
            review(report(values), report(), lock(), ON_THE_LAST_DAY)

    def test_an_available_fix_refuses(self):
        for fix in [True, {"name": "picomatch", "version": "4.0.8", "isSemVerMajor": False},
                    {"name": "eslint-config-next", "version": "16.4.6", "isSemVerMajor": False}]:
            values = lint_chain()
            values["picomatch"]["fixAvailable"] = fix
            with self.assertRaises(ValueError):
                review(report(values), report(), lock(), ON_THE_LAST_DAY)

    def test_any_step_back_npm_names_passes(self):
        # npm names a different step back from one run to another with the same lock (Claude 3 R on #4843).
        for version in ["14.2.35", "16.3.8", "15.5.29"]:
            values = lint_chain()
            values["picomatch"]["fixAvailable"] = {"name": "eslint-config-next", "version": version, "isSemVerMajor": True}
            self.assertEqual(len(review(report(values), report(), lock(), ON_THE_LAST_DAY)), len(values))

    def test_no_step_back_refuses(self):
        for fix in [{"name": "eslint-config-next", "version": "16.4.5", "isSemVerMajor": True},
                    {"name": "eslint-config-next", "version": "16.4.6", "isSemVerMajor": True},
                    {"name": "eslint-config-next", "version": "16.3.8", "isSemVerMajor": False},
                    {"name": "eslint-config-next", "version": "16.3", "isSemVerMajor": True},
                    {"name": "eslint-config-next", "version": "16.3.8-canary.1", "isSemVerMajor": True},
                    {"name": "eslint-config-next", "version": "v16.3.8", "isSemVerMajor": True},
                    {"name": "eslint-config-next", "version": "\u0661\u0664.2.35", "isSemVerMajor": True},
                    {"name": "eslint-config-next", "version": None, "isSemVerMajor": True},
                    {"name": "eslint-config-next", "isSemVerMajor": True},
                    {"name": "eslint-config-next", "version": "14.2.35"},
                    {"name": "picomatch", "version": "4.0.8", "isSemVerMajor": True},
                    True, None, "14.2.35"]:
            values = lint_chain()
            values["picomatch"]["fixAvailable"] = fix
            with self.assertRaises(ValueError):
                review(report(values), report(), lock(), ON_THE_LAST_DAY)
        values = lint_chain()
        values["picomatch"]["fixAvailable"] = {"name": "eslint-config-next", "version": "16.3.8", "isSemVerMajor": True}
        unlocked = lock()
        del unlocked["packages"]["node_modules/eslint-config-next"]
        with self.assertRaises(ValueError):
            review(report(values), report(), unlocked, ON_THE_LAST_DAY)
        for entry in ["16.4.5", {"version": "16.4"}, {"version": "16.4.5-canary.3"}, {}]:
            with self.assertRaises(ValueError):
                review(report(values), report(), lock({"node_modules/eslint-config-next": entry}), ON_THE_LAST_DAY)

    def test_a_clean_audit_needs_no_exception(self):
        self.assertEqual(review(report(), report()), [])
        self.assertEqual(review(report(), report(), None, datetime.date(2030, 1, 1)), [])

    def test_the_inputs_are_not_changed(self):
        values = lint_chain()
        before = copy.deepcopy(values)
        review(report(values), report(), lock(), ON_THE_LAST_DAY)
        self.assertEqual(values, before)


if __name__ == "__main__":
    unittest.main()
