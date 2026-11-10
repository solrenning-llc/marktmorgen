/**
 * The parts of tests/e2e/store-copy.mjs, so CI can run them on separate machines at once
 * (.github/workflows/product-checks.yml, STORE_COPY_PART="index/total"). Unset or empty runs the whole file,
 * exactly as before.
 *
 * Part 1 runs the file's own studio journey and the steps before the first boundary; part k runs the steps from
 * boundary k-1 up to the next one; the last part runs everything after the last boundary, including any step added
 * later at the end. The steps keep their order inside a part, so a part never changes which step runs before which.
 * A boundary is a step name: a missing or repeated one, or a part count that does not match the boundaries, throws
 * before anything runs, so a step can never be left out silently.
 */
export const STORE_COPY_BOUNDARIES = ["checkJoinAcknowledgment", "checkLanguageAcknowledgment"];

/**
 * @param {string | undefined} spec
 * @returns {{index: number, total: number} | null}
 */
export function parseStoreCopyPart(spec) {
  if (spec === undefined || spec === "") return null;
  const match = /^([1-9][0-9]*)\/([1-9][0-9]*)$/.exec(spec);
  const index = match ? Number(match[1]) : NaN, total = match ? Number(match[2]) : NaN;
  if (!match || index > total) throw new Error(`STORE_COPY_PART must be "index/total" with 1 <= index <= total, not ${JSON.stringify(spec)}`);
  return {index, total};
}

/**
 * Which of the named steps one part runs, and whether it runs the studio journey that precedes them.
 * @param {string[]} names the steps in file order
 * @param {{index: number, total: number} | null} part
 * @param {string[]} [boundaries]
 * @returns {{journey: boolean, steps: string[]}}
 */
export function storeCopyPartSteps(names, part, boundaries = STORE_COPY_BOUNDARIES) {
  if (new Set(names).size !== names.length) throw new Error("store-copy step names must be unique");
  const cuts = boundaries.map(name => names.indexOf(name));
  if (cuts.some(cut => cut < 1) || cuts.some((cut, at) => at > 0 && cut <= cuts[at - 1])) {
    throw new Error(`store-copy part boundaries must be steps in file order after the first: ${JSON.stringify(boundaries)}`);
  }
  if (!part) return {journey: true, steps: [...names]};
  if (part.total !== boundaries.length + 1) throw new Error(`store-copy has ${boundaries.length + 1} parts, not ${part.total}`);
  const starts = [0, ...cuts], ends = [...cuts, names.length];
  return {journey: part.index === 1, steps: names.slice(starts[part.index - 1], ends[part.index - 1])};
}
