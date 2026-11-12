const MACOS_BUILD_HEAP_MIB = 4096;

/**
 * The hosted macOS reader build has repeatedly exhausted V8's approximately
 * 2 GiB default heap during Next's type check. Keep other platforms unchanged.
 *
 * @param {NodeJS.Platform} platform
 * @param {string} [nodeOptions]
 * @returns {Record<string, string>}
 */
export function ciBuildNodeEnvironment(platform, nodeOptions) {
  if (platform !== "darwin") return {};
  const heapOption = `--max-old-space-size=${MACOS_BUILD_HEAP_MIB}`;
  return { NODE_OPTIONS: nodeOptions ? `${nodeOptions} ${heapOption}` : heapOption };
}

/** The variable next.config.ts reads to skip Next's TypeScript check (only with GITHUB_ACTIONS "true"). */
export const TYPES_CHECKED_IN_VERIFY_VARIABLE = "MARKTMORGEN_CI_TYPES_CHECKED_IN_VERIFY";

/**
 * CI browser legs whose build skips Next's TypeScript check, as "<workflow file>#<job id>".
 *
 * product-checks.yml's verify job builds the same commit with the same next.config.ts and
 * tsconfig.json and runs that check in full ("Production build and route types"); its result
 * gates "All checks (product-checks)". Every workflow below has the same triggers as
 * product-checks.yml and the same documentation-scope decision, so whenever one of these legs
 * builds, verify type-checks that commit too. Each leg spent a median of about 68 seconds
 * repeating the identical check (23 legs measured on 12 November 2026). Their build is otherwise
 * the same: compile, page data, static pages and the served output do not change.
 *
 * Anything not named here type-checks as before: verify, any new job, a job renamed, and every
 * build outside GitHub Actions (Vercel's included). tests/ci-build-type-check.test.ts holds it.
 */
export const TYPES_CHECKED_IN_VERIFY = Object.freeze([
  "accessibility-buyer-actions.yml#buyer-actions",
  "accessibility-product-actions.yml#product-actions",
  "accessibility-public-matrix.yml#public-matrix",
  "accessibility-real-readers.yml#entry-pilot",
  "accessibility-signup-actions.yml#signup-actions",
  "accessibility-studio-matrix.yml#studio-matrix",
  "product-checks.yml#cross-browser",
  "product-checks.yml#mobile-render",
]);

/**
 * The environment the synthetic build gives `next build` for its TypeScript check: "1" only for a
 * job named in TYPES_CHECKED_IN_VERIFY, read from GitHub's own GITHUB_WORKFLOW_REF
 * ("owner/repo/.github/workflows/<file>@<ref>") and GITHUB_JOB; "" everywhere else, so an
 * inherited value can never switch the check off in verify or in an unknown job.
 *
 * @param {Record<string, string | undefined>} environment
 * @returns {Record<string, string>}
 */
export function ciBuildTypeCheckEnvironment(environment) {
  const workflow = /\/\.github\/workflows\/([^/@]+)@/.exec(environment.GITHUB_WORKFLOW_REF ?? "")?.[1];
  const job = environment.GITHUB_JOB;
  const named = environment.GITHUB_ACTIONS === "true" && workflow !== undefined && job !== undefined
    && TYPES_CHECKED_IN_VERIFY.includes(`${workflow}#${job}`);
  return { [TYPES_CHECKED_IN_VERIFY_VARIABLE]: named ? "1" : "" };
}
