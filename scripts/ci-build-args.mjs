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
