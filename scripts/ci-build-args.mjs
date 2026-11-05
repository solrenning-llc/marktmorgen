const MACOS_BUILD_HEAP_MIB = 4096;

/**
 * The hosted macOS reader build has repeatedly exhausted V8's approximately
 * 2 GiB default heap during Next's type check. Keep other platforms unchanged.
 *
 * @param {NodeJS.Platform} platform
 * @returns {string[]}
 */
export function ciBuildNodeArguments(platform) {
  return platform === "darwin" ? [`--max-old-space-size=${MACOS_BUILD_HEAP_MIB}`] : [];
}
