/**
 * The whole-store export (lib/backup-export.ts exportSnapshot) reads each
 * key's ending (PEXPIRETIME) only in its exact shape, checked before an ending
 * can leave a key out: a safe integer, -1 (no ending), -2 (gone) or a time.
 * Any other number (-3, a fraction, -Infinity, an unsafe integer) and any
 * other answer (nil, a text, a list, a boolean) is unknown, so the export is
 * refused as unreadable; it is never read as "ended long ago" and a live key
 * silently left out of a copy that looks complete (Codex G's audit of #2175,
 * C4-20261106-0510-C3-18; the same order fixed in lib/backup-parts.ts by
 * #2734). Synthetic only.
 */
import { exportSnapshot } from "@/lib/backup-export";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

type Command = (string | number)[];
const T0 = Date.parse("2026-11-06T03:00:00Z");
const limits = { maxRows: 1_000, maxCommands: 10_000, batch: 16, maxBytes: 4_000_000, now: T0 };
const real = redis.pipeline.bind(redis);
const TARGET = "nl:bkx:exact:03";

function seed(): void {
  redis.clear();
  redis.now = () => T0;
  for (let i = 0; i < 6; i += 1) redis.run(["SET", `nl:bkx:exact:${String(i).padStart(2, "0")}`, `value-${i}`]);
}

async function main(): Promise<void> {
  part("Control: exact endings export every key");
  seed();
  const whole = await exportSnapshot(limits);
  is("every key exported", [whole.ok, whole.ok && whole.snapshot.rows.some((row) => row.key === TARGET)], [true, true]);

  part("An ending in another shape is unknown: the export is refused, the key never left out");
  const shapes: [string, unknown][] = [
    ["nil", null], ["an empty text", ""], ["a list", []], ["true", true], ["false", false],
    ["-3", -3], ["-0.5", -0.5], ["1.5", 1.5], ["-Infinity", -Infinity], ["an unsafe negative integer", -(2 ** 60)],
  ];
  for (const [name, reply] of shapes) {
    seed();
    redis.pipeline = async (commands: Command[]) => {
      const answers = await real(commands);
      return answers.map((answer, i) => (commands[i][0] === "PEXPIRETIME" && commands[i][1] === TARGET ? reply : answer));
    };
    let made: Awaited<ReturnType<typeof exportSnapshot>>;
    try {
      made = await exportSnapshot(limits);
    } finally {
      redis.pipeline = real;
    }
    is(`PEXPIRETIME answering ${name}: refused as unreadable, never an export without the key`, [made.ok, made.ok ? made.snapshot.rows.length : made.reason], [false, "unreadable"]);
  }
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
