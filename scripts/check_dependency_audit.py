"""Strict npm audit gate, with one expiring development-only advisory exception.

Production: no high or critical finding, ever; there is no exception for production.

Development: no high or critical finding either, except, until 1 December 2026 inclusive, the unpatched
picomatch ReDoS advisory GHSA-fc5q-39xc-vjpf reached only through the lint toolchain. The owner authorized
this narrow exception on 17 November 2026, 15:13 Fortaleza (C1-20261117-1513-c5c4c6-1). It holds only while
every one of these is true, and any other finding, change or doubt refuses:
1. today (UTC) is on or before EXCEPTION_LAST_DAY;
2. the production audit has no high or critical finding (checked first, with no exception);
3. every high or critical finding of the full audit is caused, through its whole `via` chain, only by
   ADVISORY on picomatch, range <=4.0.7, severity high;
4. only the EXCEPTED packages are found;
5. the lock holds picomatch only at LOCK_PICOMATCH (path and version), every copy `dev: true`;
6. picomatch's finding offers no fix but a semver-major step back of STEP_BACK_PACKAGE to a version strictly
   below the one in the lock (npm names 14.2.35 or 16.3.8 from one run to another with the same lock; neither
   brings a patched picomatch). `true`, another package, the same or a later version, `isSemVerMajor` not true,
   or a version that is not plain MAJOR.MINOR.PATCH may be a real fix and refuses, so it is taken in a reviewed PR.
"""
import datetime
import json
import sys
from pathlib import Path

ADVISORY = "https://github.com/advisories/GHSA-fc5q-39xc-vjpf"
EXCEPTION_LAST_DAY = datetime.date(2026, 12, 1)
EXPIRED = "exceção GHSA-fc5q-39xc-vjpf vencida: decisão do dono"
EXCEPTED = frozenset({
    "@next/eslint-plugin-next",
    "@typescript-eslint/eslint-plugin",
    "@typescript-eslint/parser",
    "@typescript-eslint/type-utils",
    "@typescript-eslint/typescript-estree",
    "@typescript-eslint/utils",
    "eslint-config-next",
    "eslint-import-resolver-typescript",
    "fast-glob",
    "fdir",
    "micromatch",
    "picomatch",
    "tinyglobby",
    "typescript-eslint",
})
LOCK_PICOMATCH = {
    "node_modules/picomatch": "2.3.2",
    "node_modules/tinyglobby/node_modules/picomatch": "4.0.5",
}
STEP_BACK_PACKAGE = "eslint-config-next"


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


def _only_this_advisory(name, all_findings, seen=()):
    """True when `name` is an excepted high finding whose whole `via` chain ends only in ADVISORY."""
    if name not in EXCEPTED or name in seen:
        return False
    item = all_findings.get(name)
    if not isinstance(item, dict) or item.get("severity") != "high":
        return False
    via = item.get("via")
    if not isinstance(via, list) or not via:
        return False
    for cause in via:
        if isinstance(cause, str):
            if not _only_this_advisory(cause, all_findings, seen + (name,)):
                return False
        elif not (isinstance(cause, dict) and cause.get("url") == ADVISORY and cause.get("name") == "picomatch"
                  and cause.get("dependency", "picomatch") == "picomatch" and cause.get("severity") == "high"
                  and cause.get("range") == "<=4.0.7"):
            return False
    return True


def _lock_picomatch_is_reviewed(lock):
    packages = lock.get("packages") if isinstance(lock, dict) else None
    if not isinstance(packages, dict):
        return False
    copies = {path: entry for path, entry in packages.items()
              if path == "node_modules/picomatch" or path.endswith("/node_modules/picomatch")}
    if set(copies) != set(LOCK_PICOMATCH):
        return False
    return all(isinstance(entry, dict) and entry.get("version") == LOCK_PICOMATCH[path] and entry.get("dev") is True
               for path, entry in copies.items())


def _version(text):
    """(major, minor, patch) for a plain ASCII MAJOR.MINOR.PATCH string; None for anything else (prerelease too)."""
    if not isinstance(text, str):
        return None
    parts = text.split(".")
    if len(parts) != 3 or not all(part.isascii() and part.isdigit() for part in parts):
        return None
    return tuple(int(part) for part in parts)


def _only_a_step_back(fix, lock):
    """True when npm's only offer is a semver-major step back of STEP_BACK_PACKAGE, below the version locked.

    npm names a different step back from one run to another with the same lock (14.2.35 or 16.3.8); neither brings a
    patched picomatch. Anything else (True, another package, the same or a later version) may be a real fix."""
    if not isinstance(fix, dict) or fix.get("name") != STEP_BACK_PACKAGE or fix.get("isSemVerMajor") is not True:
        return False
    packages = lock.get("packages") if isinstance(lock, dict) else None
    entry = packages.get("node_modules/" + STEP_BACK_PACKAGE) if isinstance(packages, dict) else None
    locked = entry.get("version") if isinstance(entry, dict) else None
    offered, current = _version(fix.get("version")), _version(locked)
    return offered is not None and current is not None and offered < current


def review(all_report, production_report, lock=None, today=None):
    """Refuse any production finding; refuse any development finding outside the one dated exception.

    Returns the development findings kept under the exception (empty for a clean audit)."""
    all_findings = findings(all_report)
    production = findings(production_report)
    found = blocked(production)
    if found:
        raise ValueError("High or critical production dependency finding: " + json.dumps(found, sort_keys=True))
    found = blocked(all_findings)
    if not found:
        return []
    detail = json.dumps(found, sort_keys=True)
    if not isinstance(today, datetime.date) or today > EXCEPTION_LAST_DAY:
        raise ValueError("Expired exception: " + EXPIRED + ". High or critical dependency finding: " + detail)
    if not set(found) <= EXCEPTED:
        raise ValueError("High or critical dependency finding outside the GHSA-fc5q-39xc-vjpf exception: " + detail)
    if not all(_only_this_advisory(name, all_findings) for name in found):
        raise ValueError("High or critical dependency finding not caused only by GHSA-fc5q-39xc-vjpf: " + detail)
    if not _lock_picomatch_is_reviewed(lock):
        raise ValueError("picomatch in the lock is not exactly the reviewed development-only copies: " + detail)
    fix = all_findings.get("picomatch", {}).get("fixAvailable")
    if "picomatch" in found and not _only_a_step_back(fix, lock):
        raise ValueError("A fix for GHSA-fc5q-39xc-vjpf is offered; update it in a reviewed PR: " + json.dumps(fix, sort_keys=True))
    return sorted(found)


def main():
    root = Path(__file__).resolve().parents[1]
    all_report = json.loads(Path(sys.argv[1]).read_text())
    production = json.loads(Path(sys.argv[2]).read_text())
    lock = json.loads((root / "package-lock.json").read_text())
    kept = review(all_report, production, lock, datetime.datetime.now(datetime.timezone.utc).date())
    print("Production high/critical findings: 0")
    print("Full dependency high/critical findings kept under the dated exception: " + str(len(kept)))
    if kept:
        print("Development-only, caused only by " + ADVISORY + " (no patched version): " + ", ".join(kept))
        print("Exception valid through " + EXCEPTION_LAST_DAY.isoformat() + " (UTC), owner's decision C1-20261117-1513-c5c4c6-1")
    print("Audit gate passed; no claim of complete vulnerability absence.")


if __name__ == "__main__":
    main()
