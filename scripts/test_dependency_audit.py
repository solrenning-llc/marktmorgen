"""Synthetic gate failures must never be mistaken for a clean audit."""
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
        for name in ["REVIEWED", "ADVISORY", "EXPIRES"]:
            self.assertFalse(hasattr(check_dependency_audit, name))

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


if __name__ == "__main__":
    unittest.main()
