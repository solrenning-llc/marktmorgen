"""Strict npm audit gate: no high or critical finding, production or development."""
import json
import sys
from pathlib import Path


def findings(report):
    if not isinstance(report, dict) or report.get("error") or report.get("auditReportVersion") != 2:
        raise ValueError("Audit unavailable or unsupported; no approval")
    values = report.get("vulnerabilities")
    counts = report.get("metadata", {}).get("vulnerabilities", {})
    if not isinstance(values, dict):
        raise ValueError("Missing audit findings")
    for severity in ["high", "critical"]:
        actual = sum(1 for value in values.values() if value.get("severity") == severity)
        if counts.get(severity) != actual:
            raise ValueError("Audit severity totals do not match")
    return values


def blocked(values):
    return {name: {"severity": item.get("severity"), "range": item.get("range"),
                   "via": item.get("via"), "fixAvailable": item.get("fixAvailable")}
            for name, item in values.items() if item.get("severity") in ["high", "critical"]}


def review(all_report, production_report):
    """Refuse any high or critical finding; there is no exception list."""
    all_findings = findings(all_report)
    production = findings(production_report)
    found = blocked(production)
    if found:
        raise ValueError("High or critical production dependency finding: " + json.dumps(found, sort_keys=True))
    found = blocked(all_findings)
    if found:
        raise ValueError("High or critical dependency finding: " + json.dumps(found, sort_keys=True))


def main():
    all_report = json.loads(Path(sys.argv[1]).read_text())
    production = json.loads(Path(sys.argv[2]).read_text())
    review(all_report, production)
    print("Production high/critical findings: 0")
    print("Full dependency high/critical findings: 0")
    print("Audit gate passed; no claim of complete vulnerability absence.")


if __name__ == "__main__":
    main()
