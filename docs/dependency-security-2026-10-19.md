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

## Dated development exception for GHSA-fc5q-39xc-vjpf — 17 November 2026

GitHub published GHSA-fc5q-39xc-vjpf ("picomatch vulnerable to ReDoS through single-branch repeated extglobs",
high, CVSS 7.5, `picomatch <=4.0.7`). No patched version exists: the latest picomatch on npm is 4.0.7, and the
advisory has no first patched version. From then on the strict gate refused every tree, main included
(MAIN VERMELHO #4842), although the production audit (`--omit=dev`) stayed at zero.

The owner authorized on 17 November 2026, 15:13 Fortaleza (C1-20261117-1513-c5c4c6-1), one narrow exception in
scripts/check_dependency_audit.py, valid through 1 December 2026 (UTC) inclusive. It holds only while all of these
are true; any other finding, change or doubt refuses:

- the production audit has no high or critical finding (no exception there, ever);
- every high or critical finding of the full audit is caused, through its whole `via` chain, only by this advisory
  on picomatch `<=4.0.7`, severity high;
- only the 14 packages of the lint toolchain reviewed on main `1fcc549cda` are found: `@next/eslint-plugin-next`,
  `@typescript-eslint/{eslint-plugin,parser,type-utils,typescript-estree,utils}`, `eslint-config-next`,
  `eslint-import-resolver-typescript`, `fast-glob`, `fdir`, `micromatch`, `picomatch`, `tinyglobby`,
  `typescript-eslint`;
- the lock holds picomatch only at `node_modules/picomatch` 2.3.2 and
  `node_modules/tinyglobby/node_modules/picomatch` 4.0.5, both `dev: true`;
- picomatch's finding offers no fix but npm's semver-major step back of `eslint-config-next` to 14.2.35: a real fix
  refuses, so it is taken in a reviewed PR.

After 1 December 2026 the gate refuses again, with "exceção GHSA-fc5q-39xc-vjpf vencida: decisão do dono".
The runtime trace check (scripts/check_dependency_runtime.py) now also keeps `picomatch`, `tinyglobby` and `fdir`
out of every production trace (Next's own compiled copy, used only by the image optimizer, which is off, is a
different path). scripts/test_dependency_audit_picomatch.py holds each condition; it runs with
scripts/test_dependency_audit.py, so no workflow changed. This is an exception for an unpatched upstream package,
not a fix, and no claim of the absence of security defects.
