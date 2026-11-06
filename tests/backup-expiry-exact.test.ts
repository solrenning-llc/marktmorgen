/**
 * The backup copy (lib/backup-parts.ts copyInParts) reads each key's ending
 * (PEXPIRETIME) only as Redis's exact integer reply: -1 (no ending), -2 (gone)
 * or a time in milliseconds. Any other answer (nil, an empty text, a list, a
 * boolean, a number that is not a safe integer, or one below -2) is unknown,
 * checked before an ending can leave a key out, so the copy is refused as
 * unreadable; it is never read as 0 ("ended long ago") and the key silently
 * left out of the backup
 * (Codex Q, rule 24 audit, 05/11/2026 21h58; Codex G on #2734). Synthetic only.
 */
import { copyInParts } from "@/lib/backup-parts";
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
  for (const [name, reply] of [["nil", null], ["an empty text", ""], ["a list", []], ["true", true], ["false", false], ["-3", -3], ["-0.5", -0.5], ["1.5", 1.5], ["-Infinity", -Infinity], ["an unsafe negative integer", -(2 ** 60)]] as [string, unknown][]) {
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
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
