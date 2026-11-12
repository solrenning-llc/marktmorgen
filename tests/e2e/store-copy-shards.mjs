/**
 * Shards of tests/e2e/store-copy.mjs, so the Firefox and WebKit jobs of
 * .github/workflows/product-checks.yml ("Cross-browser") can run it as
 * parallel matrix jobs instead of one 25-minute step.
 *
 * Every segment of the run is named here, in run order, with its weight in
 * seconds: measured in a Chromium run on a 4-core machine (12/11/2026) up to
 * checkOfferPlanning, an estimated 12 for the segments after it and for the
 * two whose pages need the internet. Weights only balance the shards; a wrong
 * one makes shards uneven, never drops a check. CI logs print each segment's
 * start ("E2E_SEGMENT"), so the weights can be refreshed from WebKit runs. Each
 * shard seeds its own stand-in services and starts its own app, and runs its
 * segments in the original order. The union of the shards is exactly every
 * segment, each once (tests/store-copy-shards.test.ts proves it, and that
 * every guarded call in store-copy.mjs is named here).
 *
 *   E2E_SHARD unset      every segment, as before (local runs, Chromium job)
 *   E2E_SHARD=2/4        only the segments of shard 2 of 4
 */

export const SHARD_COUNT = 4;

// [name, weight]: "studio-flow" is the inline studio run of store-copy.mjs
// (copy, funnels, Path, A/B test, field paint, sign-in contrast, growth and
// contact, Path privacy); every other name is the check function it guards,
// except the groups in SEGMENT_GROUPS, whose checks depend on each other's
// state and so always run together, in order, in one shard.
/**
 * Checks that must share one shard. "path-growth": the Path checks of the
 * growth store build on each other (checkPathCertificates fails without the
 * missions checkPostSalePath records; seen in a shard run, 12/11/2026).
 * "shipment": one seeded shipment read by two checks.
 * @type {Record<string, string[]>}
 */
export const SEGMENT_GROUPS = {
  "path-growth": ["checkPostSalePath", "checkReturnPath", "checkPathScripts", "checkPathWording", "checkPathCertificates"],
  shipment: ["checkShipmentAcknowledgment", "checkPurchaseResend"],
};

/** @type {[string, number][]} */
export const SEGMENTS = [
  ["studio-flow", 188],
  ["path-growth", 23],
  ["checkCertificateHeading", 12],
  ["checkPublicAmericanEnglish", 10],
  ["checkSalesComparisons", 12],
  ["checkGuidePlacement", 24],
  ["checkHomePath", 6],
  ["checkContactAcknowledgment", 18],
  ["checkRecoveryAcknowledgment", 21],
  ["checkSocialAcknowledgment", 37],
  ["checkJoinAcknowledgment", 17],
  ["checkIntroAcknowledgment", 53],
  ["checkTipsAcknowledgment", 22],
  ["checkPdfStampAcknowledgment", 8],
  ["checkPdfPreviewAcknowledgment", 6],
  ["checkFaqAcknowledgment", 14],
  ["checkSitesAcknowledgment", 9],
  ["checkLeaveAcknowledgment", 14],
  ["checkPackageAcknowledgment", 10],
  ["checkNumbersAcknowledgment", 14],
  ["checkYearlyAcknowledgment", 10],
  ["checkDunningAcknowledgment", 11],
  ["checkTierAcknowledgment", 9],
  ["checkOrderAcknowledgment", 15],
  ["checkExitAcknowledgment", 9],
  ["checkCartAcknowledgment", 13],
  ["checkEnableAcknowledgment", 14],
  ["checkPairsAcknowledgment", 11],
  ["checkCollectionsAcknowledgment", 19],
  ["checkLayoutAcknowledgment", 19],
  ["checkLookAcknowledgment", 13],
  ["checkLanguageAcknowledgment", 7],
  ["checkThanksAcknowledgment", 13],
  ["checkNoCountAcknowledgment", 9],
  ["checkNudgeAcknowledgment", 9],
  ["captureHomeStudio", 2],
  ["checkOfferPlanning", 3],
  ["checkPixelAttributionCenter", 12],
  ["checkPartnerCopy", 12],
  ["checkPublicTrustDesign", 12],
  ["checkTemplateLibrary", 12],
  ["checkEvergreenGuides", 12],
  ["checkSalesLevers", 12],
  ["checkPlatformProof", 12],
  ["checkCreatorShowcase", 12],
  ["checkSigninTerms", 12],
  ["checkStoreActivation", 12],
  ["checkHotmartComparison", 12],
  ["checkPricingValue", 12],
  ["checkCreatorJourney", 12],
  ["checkHomeHero", 12],
  ["checkHomeModules", 12],
  ["checkHomeStudioDetails", 12],
  ["checkHomeReasons", 12],
  ["checkDisputeReview", 12],
  ["checkStudioAmericanEnglish", 12],
  ["checkComposerAmericanEnglish", 12],
  ["checkBlockPickerTurnsWide", 12],
  ["checkTaxScope", 12],
  ["checkTaxSaveAcknowledgment", 12],
  ["checkRenameAcknowledgment", 12],
  ["checkDetailsAcknowledgment", 12],
  ["checkClaimAcknowledgment", 12],
  ["checkPauseAcknowledgment", 12],
  ["checkEmailCapabilities", 12],
  ["shipment", 12],
  ["checkMenuMounting", 12],
  ["checkShippingSave", 12],
  ["checkDiscountAcknowledgment", 12],
  ["checkBillingStudioObservation", 12],
  ["checkShrinkTone", 12],
];

/**
 * The segments of each of `count` shards, each list in run order. Longest
 * processing time first: heaviest segment to the least loaded shard, ties to
 * the earlier segment and the lower shard, so the split is deterministic.
 * @param {number} count
 * @param {[string, number][]} [segments]
 * @returns {string[][]}
 */
export function assignShards(count, segments = SEGMENTS) {
  if (!Number.isInteger(count) || count < 1) throw new Error(`shard count must be a positive integer, got ${count}`);
  const order = segments.map(([name, weight], index) => ({ name, weight, index }));
  for (const { name, weight } of order) {
    if (!(Number.isFinite(weight) && weight > 0)) throw new Error(`segment ${name} has no positive weight`);
  }
  if (new Set(order.map((s) => s.name)).size !== order.length) throw new Error("segment names repeat");
  const load = Array(count).fill(0);
  const shardOf = new Map();
  for (const segment of [...order].sort((a, b) => b.weight - a.weight || a.index - b.index)) {
    let best = 0;
    for (let shard = 1; shard < count; shard++) if (load[shard] < load[best]) best = shard;
    load[best] += segment.weight;
    shardOf.set(segment.name, best);
  }
  return Array.from({ length: count }, (_, shard) => order.filter((s) => shardOf.get(s.name) === shard).map((s) => s.name));
}

/** Parses "i/n" (1-based); unset or empty means the whole run. */
export function parseShard(spec) {
  if (spec === undefined || spec === "") return null;
  const match = /^([1-9][0-9]*)\/([1-9][0-9]*)$/.exec(String(spec));
  if (!match) throw new Error(`E2E_SHARD must look like 2/4, got ${JSON.stringify(spec)}`);
  const index = Number(match[1]), count = Number(match[2]);
  if (index > count) throw new Error(`E2E_SHARD ${spec}: shard ${index} of only ${count}`);
  return { index, count };
}

/**
 * take(name): whether this process runs the segment. A name not in SEGMENTS
 * throws, so a new call in store-copy.mjs cannot silently run in every shard
 * or in none. Each taken segment prints its start time, so CI logs give the
 * real durations for updating the weights above.
 */
export function shardFilter(spec, log = console.log) {
  const shard = parseShard(spec);
  const known = new Set(SEGMENTS.map(([name]) => name));
  const mine = shard ? new Set(assignShards(shard.count)[shard.index - 1]) : known;
  if (shard) log(`E2E_SHARD ${shard.index}/${shard.count}: ${[...mine].join(", ")}`);
  const started = Date.now();
  return (name) => {
    if (!known.has(name)) throw new Error(`store-copy segment ${name} is not listed in tests/e2e/store-copy-shards.mjs`);
    const runs = mine.has(name);
    if (runs) log(`E2E_SEGMENT ${JSON.stringify({ name, at: Date.now() - started })}`);
    return runs;
  };
}
