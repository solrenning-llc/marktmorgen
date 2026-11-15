# Confirmed consumption before paid resource work

AV3: can core resource allocations start off without breaking subscription or customer rights? No. Paid allowance/delivery rights remain. Optional operations need their own assessment. This change fixes actual takeAllowance admission, not full resource lifecycle coverage.

The INCRBY + EXPIRE NX response (lib/window-count.ts, `windowCountBy`; it replaced SET NX EX + INCRBY, whose key could come back with no expiry when it expired between the two) must have exactly two own data entries: a numeric safe integer at least the requested amount for the count, then explicit 0 or 1 for the EXPIRE. No string coercion, accessor, inherited entry, extra member/property/symbol or missing reply authorizes work. A committed but unconfirmed increment stays consumed. No retry, readback or compensating decrement is added on unknown evidence. Confirmed over-limit behavior remains as before.

Synthetic tests call the real function against MemoryRedis and replace only the acknowledgement after the actual increment commits. They assert refusal, one two-command call, retained consumption, no getter invocation and later confirmed recovery counting both attempts. Existing all-kind/maintenance/free-pool/limit tests remain. This is not a real Redis transport or complete source-funding proof.

No command, provider, key, expiry, retention or paid entitlement is added; the same billing window, counter and two commands remain. Fixed descriptor checks add CPU work, not a monetary zero claim. Full monthly/annual customer and company costs remain rejected until the real reviews are complete; resourceAllocations/renewals/settlement coverage stays false. No new funded operation is authorized by this change.

Accessibility: same task/steps/decisions (0→0), existing unknown-counter message retained. Full hosted CI, browser/mobile/accessibility/readers required; no human or blanket AAA claim.
