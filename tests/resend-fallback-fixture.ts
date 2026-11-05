/** Synthetic provider/account and Redis ACK boundary, with the REAL
 * transport and review validator. This does not emulate/prove the Lua;
 * scripts/test_resend_fallback_budget_redis.py executes that exact Lua.
 */
import { createHash } from "node:crypto";
import { currentResendFallbackProofIsMissing as realProofIsMissing, guardedResendPost as realPost, type ResendPost, type ResendTransportRuntime } from "../lib/resend-fallback-transport";
import { initializeResendFallbackBudget, RESEND_FALLBACK_BUDGET_LUA, type ResendFallbackReview } from "../lib/resend-fallback-budget";
import { store } from "./redis-stub";
import { MemoryRedis } from "@/lib/redis-memory";
import { syntheticResendCredential, type SyntheticResendCredential } from "./resend-fixture-credentials";

const hash = (s: string) => createHash("sha256").update(s).digest("hex");
type Claim = { token: string; n: number; fingerprint: string; dispatchToken: string; acceptedAt: number; expiresAt: number; state: "reserved" | "dispatched" | "unknown" | "accepted" | "confirmed_not_accepted" };
type FixtureOptions = {
  credential: string; usageCredential?: string; cap?: number; sent?: number; received?: number;
  accountId?: string; fetch?: typeof fetch;
};
/** Prepare the exact finite review/binding synchronously for the no-IO
 * proof predicate. Sending still awaits this fixture's initialization. */
export function prepareResendFallbackFixture(options: FixtureOptions) {
  if (!options || ![Object.prototype, null].includes(Object.getPrototypeOf(options))) throw Error("Unknown synthetic fixture credential");
  const sending = Object.getOwnPropertyDescriptor(options, "credential");
  const reading = Object.getOwnPropertyDescriptor(options, "usageCredential");
  const credential = syntheticResendCredential(sending && Object.hasOwn(sending, "value") ? sending.value : null);
  const usageCredential = syntheticResendCredential(reading
    ? Object.hasOwn(reading, "value") ? reading.value === undefined ? credential : reading.value : null
    : credential);
  if (!credential || !usageCredential) throw Error("Unknown synthetic fixture credential");
  const now = Date.now(), start = now - 86_400_000, reset = now + 30 * 86_400_000;
  const cap = options.cap ?? 50_000, received = options.received ?? 0;
  const accountId = options.accountId ?? "SYNTHETIC_RESEND_TRANSPORT_ACCOUNT";
  const review: ResendFallbackReview = {
    schema: 1, reviewId: "SYNTHETIC_TRANSPORT_REVIEW", accountId,
    paidPlan: "Pro", paidForPeriod: true, includedEmails: cap,
    periodStartMs: start, resetsAtMs: reset, checkedAtMs: now, validUntilMs: reset,
    evidence: "SYNTHETIC ONLY; not a live plan or payment",
    protection: { kind: "inclusive_provider_hard_cap", sentAndReceived: true, overagesDisabled: true, capEmails: cap, evidence: "SYNTHETIC ONLY" },
    bootstrap: { noUnresolvedPriorAttempts: true, allPriorUsageIncluded: true, evidence: "Explicit synthetic fixture initialization" },
  };
  const claims = new Map<string, Claim>();
  const acknowledgements = new MemoryRedis();
  let initialized = false, held = 0, accepted = options.sent ?? 0, lost: string | null = null;
  const commands: (string | number)[][] = [], requests: { method: string; url: string; body?: string }[] = [];
  const pipeline: NonNullable<ResendTransportRuntime["pipeline"]> = async batch => {
    const results: unknown[] = [];
    for (const c of batch) {
      commands.push([...c]);
      if (c[0] !== "EVAL" || c[1] !== RESEND_FALLBACK_BUDGET_LUA) throw Error("Fixture only handles the exact budget protocol");
      const a = c.slice(5), op = String(a[0]), token = String(a[2]), n = Number(a[3]), claimKey = String(c[4]);
      let reply: unknown;
      if (op === "initialize") { initialized = true; reply = ["initialized"]; }
      else if (!initialized) reply = ["denied", "uninitialized"];
      else if (op === "reserve") {
        const old = claims.get(claimKey);
        if (old && old.fingerprint !== String(a[20])) reply = ["denied", "claim_conflict"];
        else if (old && old.state !== "confirmed_not_accepted") reply = old.state === "reserved"
          ? ["already_reserved", old.token, String(old.n), String(start), String(reset), String(reset)]
          : ["denied", "already_dispatched"];
        else if (accepted + received + held + n > cap) reply = ["denied", "quota"];
        else {
          claims.set(claimKey, { token, n, state: "reserved", fingerprint: String(a[20]), dispatchToken: "", acceptedAt: 0, expiresAt: 0 }); held += n;
          reply = ["reserved", token, String(n), String(start), String(reset), String(reset)];
        }
      } else {
        const claim = claims.get(claimKey);
        if (op === "receipt") {
          reply = claim?.state === "accepted" && claim.fingerprint === String(a[20]) && claim.n === n && Date.now() >= claim.acceptedAt && Date.now() < claim.expiresAt
            ? ["accepted", String(a[1]), String(a[13]), claim.fingerprint, String(n), String(claim.acceptedAt), String(claim.expiresAt), String(Date.now())]
            : ["denied", "receipt_unknown"];
        } else if (!claim || claim.token !== token || claim.n !== n || claim.fingerprint !== String(a[20])) reply = ["denied", "claim"];
        else if (op === "dispatch") {
          if (claim.state !== "reserved") reply = ["denied", "already_dispatched"];
          else { claim.state = "dispatched"; claim.dispatchToken = String(a[21]); reply = ["dispatch", token, String(n), String(Math.min(Number(a[6]) + 1000, reset)), claim.dispatchToken, String(a[6])]; }
        } else if (op === "cancel") {
          if (claim.state === "confirmed_not_accepted") reply = ["already_released"];
          else if (claim.state !== "reserved") reply = ["denied", "already_dispatched"];
          else { claim.state = "confirmed_not_accepted"; held -= n; reply = ["released"]; }
        } else if (op === "settle") {
          const outcome = String(a[18]) as Claim["state"];
          if (!claim.dispatchToken || claim.dispatchToken !== String(a[21])) reply = ["denied", "dispatch_identity"];
          else if (claim.state === "accepted" || claim.state === "confirmed_not_accepted") reply = ["already_settled", claim.state];
          else {
            claim.state = outcome;
            if (outcome === "accepted") { held -= n; accepted += n; claim.acceptedAt = Date.now(); claim.expiresAt = claim.acceptedAt + 35 * 86_400_000; }
            if (outcome === "confirmed_not_accepted") held -= n;
            reply = ["settled", outcome];
          }
        } else throw Error("Unexpected budget operation");
      }
      // This account is a separate synthetic provider/ledger fixture. Its
      // ACK records must not contaminate the application's erasure database.
      acknowledgements.run(["SET", `synthetic:resend:ack:${claimKey}`, JSON.stringify(claims.get(claimKey) ?? { initialized })]);
      if (op === lost) { lost = null; throw Error("Synthetic committed ACK loss"); }
      results.push(reply);
    }
    return results;
  };
  const usage = () => ({ source: "resend_usage_api" as const, accountId, observedAtMs: Date.now(), monthly: {
    used: accepted + received, sent: accepted, received, limit: cap, resetsAt: new Date(reset).toISOString(),
  } });
  const runtime: ResendTransportRuntime = {
    review, pipeline,
    binding: { accountId, evidence: "SYNTHETIC credential/account proof only", checkedAtMs: now, validUntilMs: reset,
      usageCredentialSha256: hash(usageCredential), sendingCredentialSha256s: [...new Set([hash(usageCredential), hash(credential)])] },
    fetch: (async (input, init) => {
      const url = String(input), method = init?.method ?? "GET";
      requests.push({ method, url, ...(typeof init?.body === "string" ? { body: init.body } : {}) });
      if (new URL(url).pathname === "/usage") {
        if (new Headers(init?.headers).get("authorization") !== `Bearer ${usageCredential}`) throw Error("Wrong usage account credential");
        const snapshot = usage();
        return Response.json({ object: "usage", emails: { monthly: { ...snapshot.monthly, resets_at: snapshot.monthly.resetsAt } } });
      }
      return (options.fetch ?? fetch)(input, init);
    }) as typeof fetch,
  };
  const ready = initializeResendFallbackBudget({ review, usage: usage() }, { pipeline }).then(boot => {
    if (boot.status !== "initialized") throw Error("Synthetic reviewed initialization failed");
  });
  return { runtime, ready, review, requests, commands, claims, usage, loseNext: (op: string) => { lost = op; }, held: () => held };
}
export async function createResendFallbackFixture(options: FixtureOptions) {
  const fixture = prepareResendFallbackFixture(options);
  await fixture.ready;
  return fixture;
}

// Application journeys use the same real guard with an explicitly synthetic
// account, usage HTTP response and ACK adapter. Tests of the real defaults
// and guard import the product module by relative path and are not aliased.
const worlds = new Map<string, ReturnType<typeof prepareResendFallbackFixture>>();
const clearApplication = store.clear.bind(store);
store.clear = () => { clearApplication(); worlds.clear(); };
function applicationWorld(credential: SyntheticResendCredential, usageCredential: SyntheticResendCredential) {
  const name = `${usageCredential}\n${Math.floor(Date.now() / 86_400_000)}`;
  let world = worlds.get(name);
  // Restoring the clock after a future-time journey starts a new synthetic
  // context, never a live ledger reset. Retain the existing finite epoch.
  if (!world || Date.now() < world.runtime.binding!.checkedAtMs) {
    world = prepareResendFallbackFixture({ credential, usageCredential, fetch: (request, init) => fetch(request, init) });
    worlds.set(name, world);
  }
  const binding = world.runtime.binding!;
  if (!binding.sendingCredentialSha256s.includes(hash(credential))) binding.sendingCredentialSha256s.push(hash(credential));
  return world;
}
export function currentResendFallbackProofIsMissing(runtime: ResendTransportRuntime = {}) {
  if (Object.keys(runtime).length) return realProofIsMissing(runtime);
  const credential = syntheticResendCredential(process.env.RESEND_API_KEY?.trim());
  const usageCredential = syntheticResendCredential(process.env.RESEND_READ_API_KEY?.trim() || credential);
  if (!credential || !usageCredential) return true;
  return realProofIsMissing(applicationWorld(credential, usageCredential).runtime);
}
export async function guardedResendPost(input: ResendPost, runtime: ResendTransportRuntime = {}) {
  if (Object.keys(runtime).length) return realPost(input, runtime);
  const credential = syntheticResendCredential(input.credential);
  const usageCredential = syntheticResendCredential(input.usageCredential);
  if (!credential || !usageCredential) return { kind: "blocked" as const };
  const world = applicationWorld(credential, usageCredential);
  await world.ready;
  return realPost(input, world.runtime);
}
