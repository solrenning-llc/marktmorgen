"""Synthetic gate failures must never be mistaken for a clean audit."""
import inspect
import json
import tempfile
import unittest
from pathlib import Path
import check_dependency_audit
from check_dependency_audit import review
from check_dependency_runtime import check_traces


def report(values=None):
    values = values or {}
    return {"auditReportVersion": 2, "vulnerabilities": values, "metadata": {"vulnerabilities": {
        "high": sum(v["severity"] == "high" for v in values.values()),
        "critical": sum(v["severity"] == "critical" for v in values.values()),
    }}}


def finding(severity="high"):
    # The development-only chain once excepted (GHSA-vfj7-8cjw-p6xm, withdrawn 23 Oct 2026).
    return report({"braces": {"severity": severity, "nodes": ["node_modules/braces"], "via": [{
        "name": "braces", "url": "https://github.com/advisories/GHSA-vfj7-8cjw-p6xm",
        "severity": severity, "range": "<=3.0.3"}]}})


class GateTests(unittest.TestCase):
    def test_clean_audit_passes(self):
        self.assertIsNone(review(report(), report()))

    def test_low_and_moderate_findings_pass(self):
        for severity in ["low", "moderate"]:
            self.assertIsNone(review(finding(severity), finding(severity)))

    def test_no_exception_list_remains(self):
        # The withdrawn braces exception (GHSA-vfj7-8cjw-p6xm) and the dated picomatch exception
        # (GHSA-fc5q-39xc-vjpf, #4843) both stay gone: the lint toolchain that pulled picomatch in was
        # replaced by oxlint, so the gate is strict again, with no exception of any kind.
        for name in ["REVIEWED", "EXPIRES", "ADVISORY", "EXCEPTION_LAST_DAY", "EXPIRED", "EXCEPTED",
                     "LOCK_PICOMATCH", "ONLY_NPM_FIX", "STEP_BACK_PACKAGE"]:
            self.assertFalse(hasattr(check_dependency_audit, name), name)
        self.assertEqual(list(inspect.signature(review).parameters), ["all_report", "production_report"])
        source = Path(check_dependency_audit.__file__).read_text()
        for text in ["GHSA-", "advisories/", "datetime", "EXCEPT"]:
            self.assertNotIn(text, source)

    def test_the_picomatch_advisory_refuses_like_any_other(self):
        # GHSA-fc5q-39xc-vjpf still has no patched picomatch; if it comes back into the tree, the gate refuses.
        picomatch = report({"picomatch": {"severity": "high", "nodes": ["node_modules/picomatch"], "via": [{
            "name": "picomatch", "dependency": "picomatch", "severity": "high", "range": "<=4.0.7",
            "url": "https://github.com/advisories/GHSA-fc5q-39xc-vjpf"}],
            "fixAvailable": {"name": "eslint-config-next", "version": "14.2.35", "isSemVerMajor": True}}})
        with self.assertRaises(ValueError):
            review(picomatch, report())

    def test_development_high_or_critical_refuses(self):
        for severity in ["high", "critical"]:
            with self.assertRaises(ValueError):
                review(finding(severity), report())

    def test_production_high_or_critical_refuses(self):
        for severity in ["high", "critical"]:
            with self.assertRaises(ValueError):
                review(finding(severity), finding(severity))
            with self.assertRaises(ValueError):
                review(report(), finding(severity))

    def test_unavailable_and_inconsistent_reports_refuse(self):
        for audit in [{}, {"error": {"message": "Registry unavailable"}}, report({"unknown": {"severity": "high"}})]:
            with self.assertRaises(ValueError):
                review(audit, report())
            with self.assertRaises(ValueError):
                review(report(), audit)

    def test_runtime_trace_is_mandatory_and_catches_the_chain(self):
        with tempfile.TemporaryDirectory() as folder:
            with self.assertRaises(ValueError):
                check_traces(folder)
            trace = Path(folder) / "route.js.nft.json"
            trace.write_text(json.dumps({"files": ["../node_modules/next/dist/server.js"]}))
            self.assertEqual(check_traces(folder), 1)
            trace.write_text(json.dumps({"files": ["../node_modules/braces/index.js"]}))
            with self.assertRaises(ValueError):
                check_traces(folder)
            # The picomatch chain of GHSA-fc5q-39xc-vjpf is development-only too (Next's own compiled copy is not it).
            for package in ["picomatch", "tinyglobby", "fdir"]:
                trace.write_text(json.dumps({"files": ["../node_modules/" + package + "/index.js"]}))
                with self.assertRaises(ValueError):
                    check_traces(folder)
            trace.write_text(json.dumps({"files": ["../node_modules/next/dist/compiled/picomatch/index.js"]}))
            self.assertEqual(check_traces(folder), 1)


if __name__ == "__main__":
    unittest.main()
