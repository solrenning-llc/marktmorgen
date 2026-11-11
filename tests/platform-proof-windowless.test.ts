/**
 * #3738, Claude 1's LEVE (6803981513) on the fix for the LOW on #3509: lib/platform-proof-store.ts still exported
 * readPlatformProof(), which hands back the kept snapshot without the window it was written for, so a future reader
 * could still choose the window itself (what the LOW asked to prevent). The module's only readers now carry the
 * window: readPlatformProofKept (the snapshot and its validDays) and keptPlatformProof (the counters on that window).
 * Synthetic Redis only.
 */
import * as store from "@/lib/platform-proof-store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

async function main(): Promise<void> {
  part("No reader of the kept snapshot without its window");
  const exported = store as unknown as Record<string, unknown>;
  is("readPlatformProof is not exported", "readPlatformProof" in exported, false);
  const readers = Object.keys(exported).filter((name) => /^(read|kept)/.test(name) && typeof exported[name] === "function").sort();
  is("the module's readers are only the ones that carry the window", readers, ["keptPlatformProof", "readPlatformProofKept"]);

  part("The window is read with the snapshot");
  redis.clear();
  const DAY = 86_400_000;
  const asOf = new Date(Date.now() - 2 * DAY).toISOString().replace(/\.\d{3}Z$/, "Z");
  const snapshot = { asOf, evidenceRef: "synthetic-count", mode: "live" as const, excludesDemoAndTest: true as const, counts: { stores: 120, sales: 1500, activeCreators: 60 }, activeWindowDays: 30 };
  await store.writePlatformProof(snapshot, 30);
  is("read back with its window", await store.readPlatformProofKept(), { snapshot, validDays: 30 });
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
