/** Codex G derivative: original six assertions unchanged; adds five invalid numeric expiry vectors and decrypts the actual artifact. */
/**
 * The backup copy (lib/backup-parts.ts copyInParts) reads each key's ending
 * (PEXPIRETIME) only as Redis's exact integer reply: -1 (no ending), -2 (gone)
 * or a time in milliseconds. Any other answer (nil, an empty text, a list, a
 * boolean) is unknown, so the copy is refused as unreadable; it is never read
 * as 0 ("ended long ago") and the key silently left out of the backup
 * (Codex Q, rule 24 audit, 05/11/2026 21h58). Synthetic only.
 */
import { copyInParts, openManifest } from "@/lib/backup-parts";
import { openBackup } from "@/lib/backup-codec";
import type { BackupObjectStore } from "@/lib/backup-roundtrip";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

type Command = (string | number)[];
const T0 = Date.parse("2026-11-06T03:00:00Z");
const key = Buffer.alloc(32, 7);
const objects = new Map<string, Uint8Array>();
const store: BackupObjectStore = {
  putNew: async (id, bytes) => {
    if (objects.has(id)) throw new Error("exists");
    objects.set(id, new Uint8Array(bytes));
  },
  read: async (id) => objects.get(id) ?? Promise.reject(new Error("missing")),
};
const limits = { maxRows: 100, maxCommands: 1_000, maxParts: 10, maxRunBytes: 1_000_000, batch: 7, now: T0, partBytes: 4_096 };
const real = redis.pipeline.bind(redis);
const TARGET = "nl:bk:exact:03";

function seed(): void {
  redis.clear();
  redis.now = () => T0;
  objects.clear();
  for (let i = 0; i < 6; i += 1) redis.run(["SET", `nl:bk:exact:${String(i).padStart(2, "0")}`, `value-${i}`]);
}

async function main(): Promise<void> {
  part("Control: exact endings copy every key");
  seed();
  const whole = await copyInParts(limits, key, store);
  is("every key copied", [whole.ok, whole.ok && whole.keys], [true, 6]);

  part("An ending answered in another shape is unknown: the copy is refused, the key never left out");
  for (const [name, reply] of [["nil", null], ["an empty text", ""], ["a list", []], ["true", true], ["false", false]] as [string, unknown][]) {
    seed();
    redis.pipeline = async (commands: Command[]) => {
      const answers = await real(commands);
      return answers.map((answer, i) => (commands[i][0] === "PEXPIRETIME" && commands[i][1] === TARGET ? reply : answer));
    };
    let made: Awaited<ReturnType<typeof copyInParts>>;
    try {
      made = await copyInParts(limits, key, store);
    } finally {
      redis.pipeline = real;
    }
    is(`PEXPIRETIME answering ${name}: refused as unreadable, never a backup without the key`, [made.ok, made.ok ? made.keys : made.reason], [false, "unreadable"]);
  }
  part("Codex G: invalid numeric endings must be rejected before the already-expired skip");
  for (const [name, reply] of [["unsupported negative sentinel", -3], ["negative fraction", -0.5], ["fractional past timestamp", 1.5], ["negative infinity", Number.NEGATIVE_INFINITY], ["unsafe negative integer", -9_007_199_254_740_992]] as [string, number][]) {
    seed();
    let hit = 0;
    redis.pipeline = async (commands: Command[]) => {
      const answers = await real(commands);
      return answers.map((answer, i) => {
        if (commands[i][0] === "PEXPIRETIME" && commands[i][1] === TARGET) { hit += 1; return reply; }
        return answer;
      });
    };
    let made: Awaited<ReturnType<typeof copyInParts>>;
    try { made = await copyInParts(limits, key, store); } finally { redis.pipeline = real; }
    const manifest = made.ok ? openManifest(objects.get(made.id)!, key) : null;
    const rows = manifest ? manifest.parts.flatMap((part) => openBackup(objects.get(part.id)!, key).rows) : [];
    is(`${name}: exactly one target reply replaced; original source key still exists`, [hit, redis.run(["GET", TARGET])], [1, "value-3"]);
    is(`${name}: refuse rather than silently omit a source key`, [made.ok, made.ok ? made.keys : made.reason], [false, "unreadable"]);
    is(`${name}: no verified manifest names a partial copy as complete`, made.ok && !rows.some((row) => row.key === TARGET), false);
  }
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
