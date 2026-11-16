# Dependency security review — 19 October 2026

The full npm audit reports five high-severity findings from one underlying
advisory: GHSA-vfj7-8cjw-p6xm / CVE-2026-93687, recursive brace-pattern parsing.
The official advisory lists braces through 3.0.3 as affected and no patched
version: https://github.com/advisories/GHSA-vfj7-8cjw-p6xm .

The lockfile's exact development-only chain is eslint-config-next 16.3.8,
@next/eslint-plugin-next 16.3.8, fast-glob 3.3.1, micromatch 4.0.8 and
braces 3.0.3. A compatible npm audit fix did not resolve it. Its unrelated
lockfile changes were discarded. The suggested forced downgrade of the Next
ESLint configuration to 14.2.35 was not applied to a Next 16.3.8 application.

## Enforced review

- Production audit permits no high or critical finding.
- Full audit permits only this exact unchanged development-only chain and
  advisory. New advisories, changed versions, production classification,
  critical findings, missing/malformed reports and registry failures refuse
  approval.
- The narrow development review expires on 18 November 2026; expiration
  refuses approval rather than renewing itself. A fully clean audit needs
  no exception.
- After every production build, all Next .nft.json dependency traces are
  checked. Any member of the reviewed chain in a runtime trace fails.
- Synthetic tests cover refusals, expiry, production exposure and missing
  or contaminated traces. Full product, browser and Redis checks remain.

This adds checks, not a patch for an unpatched upstream package. Five development
findings remain visible; a clean production audit or trace check does not certify
the absence of all security defects. No application feature, price, quota,
commercial gate or tax assumption changes.

## Advisory withdrawn — 6 November 2026

GitHub withdrew GHSA-vfj7-8cjw-p6xm on 23 October 2026 as not a practically
exploitable vulnerability, and npm audit no longer reports it. The development
exception above, with its pinned chain and 18 November expiry, was removed from
scripts/check_dependency_audit.py: the full and production audits now both refuse
any high or critical finding, with no exception list. The runtime trace check
(scripts/check_dependency_runtime.py) is unchanged and still keeps this
development-only chain out of every production trace.
