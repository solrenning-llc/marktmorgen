/**
 * The figures of an Amazon SNS notice's receipt (lib/sns-receipt.ts), with no imports, so the cost registry
 * (tests/plan-cost-registry.ts) counts them from the code without loading Redis.
 */
/** How long a receipt is kept: a day, as before this protocol (tests/store-data-registry.ts). */
export const SNS_RECEIPT_SECONDS = 86_400;
/** The value a finished notice's receipt holds. */
export const SNS_RECEIPT_DONE = "done";
/**
 * How long a pending receipt belongs to the run that wrote it: the route's maxDuration (30 seconds), after which the
 * platform has ended that run, and five seconds more for its last Redis request.
 */
export const SNS_RECEIPT_LEASE_MS = 35_000;
/**
 * The most Redis commands one delivery's receipt is billed, scripts' inner commands included (Upstash bills them one
 * by one): SET NX, GET, the take-over script (EVAL, GET, SET) and the done or let-go script (EVAL, GET, SET or DEL).
 * Held by tests/ses-dedup-ack.test.ts and counted in tests/plan-cost-registry.ts (mailReportCallbackCost).
 */
export const SNS_RECEIPT_COMMANDS_MOST = 8;
/** The longest value a receipt holds: claimValue's 13-digit time, a point and nine digits. */
export const SNS_RECEIPT_VALUE_BYTES_MOST = 23;
