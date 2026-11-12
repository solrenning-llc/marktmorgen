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

/** The one argument ci-build.mjs takes: skip Next's TypeScript check in this build. */
export const SKIP_TYPE_CHECK_FLAG = "--skip-type-check";
/** What ci-build.mjs hands the build; next.config.ts reads it only inside GitHub Actions. */
export const SKIP_TYPE_CHECK_ENV = "MARKTMORGEN_CI_SKIP_TYPE_CHECK";

/**
 * Next's type check is about 51 s of a 93 s CI build (product-checks, 12/11/2026), and a merge
 * group built the same commit about twenty times, type-checking it each time. The verify job's
 * "Production build and route types" (product-checks, a required check) keeps the check, so a
 * type error still fails every pull request and merge group; the browser and accessibility jobs,
 * which only need the built app, pass SKIP_TYPE_CHECK_FLAG.
 *
 * The variable is always set, "1" or "0", from the arguments alone, so a job's own environment
 * can never switch the check off.
 *
 * @param {readonly string[]} args the arguments after the script's path
 * @returns {Record<string, string>}
 */
export function ciBuildTypeCheckEnvironment(args) {
  const unknown = args.filter((arg) => arg !== SKIP_TYPE_CHECK_FLAG);
  if (unknown.length) throw new Error(`ci-build.mjs: unknown argument(s) ${unknown.join(" ")}; the only one is ${SKIP_TYPE_CHECK_FLAG}`);
  return { [SKIP_TYPE_CHECK_ENV]: args.includes(SKIP_TYPE_CHECK_FLAG) ? "1" : "0" };
}
