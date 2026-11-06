/** G corrective-return controls: refusal after an earlier successful batch exposes no partial snapshot. */
import { exportSnapshot } from "@/lib/backup-export";
import { store as redis } from "./redis-stub";
import { done, is } from "./check";
type Command = (string | number)[];
const now = Date.parse("2026-11-06T07:00:00Z");
const real = redis.pipeline.bind(redis);
const limits = { maxRows: 20, maxCommands: 100, batch: 2, maxBytes: 100_000, now };
async function main(): Promise<void> {
  for (const expiry of [-3, -0.5, -Infinity, -(2 ** 60)]) {
    redis.clear(); redis.now = () => now;
    for (let i = 0; i < 7; i += 1) redis.run(["SET", `nl:g:batched:${i}`, `v${i}`]);
    let dumps = 0;
    redis.pipeline = async (commands: Command[]) => {
      dumps += commands.filter((c) => c[0] === "DUMP").length;
      return (await real(commands)).map((reply, i) => commands[i][0] === "PEXPIRETIME" && commands[i][1] === "nl:g:batched:2" ? expiry : reply);
    };
    let result: Awaited<ReturnType<typeof exportSnapshot>>;
    try { result = await exportSnapshot(limits); } finally { redis.pipeline = real; }
    is(`${String(expiry)}: refused after the second batch, not a partial snapshot`, result, { ok: false, reason: "unreadable", commands: 9 });
    is(`${String(expiry)}: no later batch or source mutation`, [dumps, Array.from({ length: 7 }, (_, i) => redis.run(["GET", `nl:g:batched:${i}`]))], [4, Array.from({ length: 7 }, (_, i) => `v${i}`)]);
  }
  done();
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
