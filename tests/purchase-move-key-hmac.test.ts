/**
 * Codex G on #3659 (MEDIUM, privacy): the Redis keys a purchase move names by its addresses (nl:pm:day:<fp> for the
 * old address's count of the day, nl:pm:retry:<fp> for the same-day retry of an exact ask) must not be a plain hash
 * of public inputs. Whoever reads key names and knows a buyer's address could hash likely addresses with the day and
 * the scope and match them. Each is a keyed HMAC under a key derived from the server's secret (lib/secret-box.ts).
 */
import { createHash } from "node:crypto";
import { askPurchaseMove } from "@/lib/purchase-moves";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.NIMBUS_DATA_KEY ??= "tests-only-not-a-real-deployment-secret";
const sha = (value: string) => createHash("sha256").update(value).digest("hex");

async function main(): Promise<void> {
  redis.clear();
  const now = Date.UTC(2026, 10, 12, 12);
  const from = "old.buyer@example.com", to = "new.buyer@example.com";
  const asked = await askPurchaseMove({ from, to, scope: "all", now });
  is("the ask is taken", asked.ok, true);
  const day = Math.floor(now / 86_400_000);
  const keys = redis.keys();
  const dayKeys = keys.filter((k) => k.startsWith("nl:pm:day:"));
  const retryKeys = keys.filter((k) => k.startsWith("nl:pm:retry:"));

  part("Neither key is a plain hash anybody who knows the addresses can work out");
  const plainDay = `nl:pm:day:${sha(`nimbus-pm-day:${day}:${from}`).slice(0, 32)}`;
  const plainRetry = `nl:pm:retry:${sha(`nimbus-pm-retry:v1:${day}:${JSON.stringify(["all", from, to])}`).slice(0, 32)}`;
  is("one day's count, under a 32-character fingerprint", dayKeys.length === 1 && /^nl:pm:day:[0-9a-f]{32}$/.test(dayKeys[0]), true);
  is("one retry index, under a 32-character fingerprint", retryKeys.length === 1 && /^nl:pm:retry:[0-9a-f]{32}$/.test(retryKeys[0]), true);
  is("the day's count is not the plain hash of the address and the day", dayKeys[0] === plainDay, false);
  is("the retry index is not the plain hash of the two addresses, the scope and the day", retryKeys[0] === plainRetry, false);

  part("Another server secret gives other keys");
  redis.clear();
  const kept = process.env.NIMBUS_DATA_KEY;
  process.env.NIMBUS_DATA_KEY = "tests-only-another-deployment-secret";
  try {
    await askPurchaseMove({ from, to, scope: "all", now });
    is("the day's count moves with the secret", redis.keys().some((k) => k === dayKeys[0]), false);
    is("the retry index moves with the secret", redis.keys().some((k) => k === retryKeys[0]), false);
  } finally {
    process.env.NIMBUS_DATA_KEY = kept;
  }
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
