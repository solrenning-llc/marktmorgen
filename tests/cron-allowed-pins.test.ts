/**
 * Authorization of the scheduled jobs (lib/request-guard.ts cronAllowed): every app/api/cron/** route runs only for
 * `Authorization: Bearer <CRON_SECRET>`, compared in constant time; with no secret set, the door is shut in
 * production (Vercel's previews run as production too) and open only on a local development server. Nothing pinned
 * the production case or the near misses, so a regression here would let anyone start every job (payouts, refunds,
 * erasure sweeps, emails). Synthetic headers only.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { cronAllowed, sameSecret } from "@/lib/request-guard";

const env = process.env as Record<string, string | undefined>;
const request = (authorization?: string) => ({ headers: new Headers(authorization === undefined ? {} : { authorization }) });
function withEnv(values: Record<string, string | undefined>, run: () => Promise<void>): () => Promise<void> {
  return async () => {
    const before = Object.fromEntries(Object.keys(values).map((k) => [k, env[k]]));
    try {
      for (const [k, v] of Object.entries(values)) if (v === undefined) delete env[k]; else env[k] = v;
      await run();
    } finally {
      for (const [k, v] of Object.entries(before)) if (v === undefined) delete env[k]; else env[k] = v;
    }
  };
}
const SECRET = "cron-secret-for-tests-only-0123456789";

test("with the secret set, only its exact bearer header runs a job", withEnv({ CRON_SECRET: SECRET, NODE_ENV: "production" }, async () => {
  assert.equal(await cronAllowed(request(`Bearer ${SECRET}`)), true);
  for (const header of [undefined, "", "Bearer", "Bearer ", `bearer ${SECRET}`, `Basic ${SECRET}`, SECRET, `Bearer ${SECRET}x`, `Bearer ${SECRET.slice(0, -1)}`, `Bearer  ${SECRET}`]) {
    assert.equal(await cronAllowed(request(header)), false, JSON.stringify(header));
  }
}));

test("a secret with surrounding spaces in the environment is read trimmed", withEnv({ CRON_SECRET: `  ${SECRET}\n`, NODE_ENV: "production" }, async () => {
  assert.equal(await cronAllowed(request(`Bearer ${SECRET}`)), true);
}));

test("no secret in production (or a blank one) shuts the door, whatever is sent", withEnv({ CRON_SECRET: undefined, NODE_ENV: "production" }, async () => {
  for (const header of [undefined, "Bearer ", "Bearer anything", "Bearer undefined"]) assert.equal(await cronAllowed(request(header)), false, String(header));
  env.CRON_SECRET = "   ";
  assert.equal(await cronAllowed(request("Bearer ")), false);
  assert.equal(await cronAllowed(request("Bearer    ")), false);
}));

test("no secret on a local development server leaves the jobs to be started by hand", withEnv({ CRON_SECRET: undefined, NODE_ENV: "development" }, async () => {
  assert.equal(await cronAllowed(request()), true);
}));

test("sameSecret: equal only for the same non-empty text", async () => {
  assert.equal(await sameSecret(SECRET, SECRET), true);
  assert.equal(await sameSecret("", ""), false);
  assert.equal(await sameSecret(SECRET.toUpperCase(), SECRET), false);
  assert.equal(await sameSecret(`${SECRET}0`, SECRET), false);
  assert.equal(await sameSecret("a", "b"), false);
});
