/**
 * The support script for a broken move (scripts/move-repair.mjs, which runs
 * scripts/move-repair-run.ts) changes nothing without --yes-production: built
 * here as it is built there, with lib/move-repair.ts swapped for a stand-in
 * that only says what it was asked, and run with each set of flags (review of
 * #2140, task 47). No Redis is touched. esbuild runs in a child process, as
 * the script runs it, since a test bundle cannot carry it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(".");

test("the move repair script changes nothing without --yes-production, and does what it is asked with it", () => {
  const out = mkdtempSync(join(tmpdir(), "move-repair-script-"));
  try {
    const stand = join(out, "move-repair-stand-in.ts");
    writeFileSync(stand, [
      'export async function describeMove(email: string) { return { broken: null, addresses: [{ address: email }] }; }',
      'export async function repairMove() { console.log("CALLED repairMove"); return true; }',
      'export async function clearBrokenMoveByHand() { console.log("CALLED clearBrokenMoveByHand"); return "cleared"; }',
    ].join("\n"));
    const bundle = join(out, "run.cjs");
    const options = { entryPoints: [join(root, "scripts", "move-repair-run.ts")], bundle: true, platform: "node", format: "cjs", outfile: bundle, logLevel: "error", alias: { "@/lib/move-repair": stand, "@": root } };
    const built = spawnSync(process.execPath, ["--input-type=module", "-e", `import { build } from "esbuild"; await build(${JSON.stringify(options)});`], { cwd: root, encoding: "utf8" });
    assert.equal(built.status, 0, built.stderr);
    const run = (...args: string[]) => {
      const env = { ...process.env, UPSTASH_REDIS_REST_URL: "https://made-up.example.com", KV_REST_API_URL: "" };
      const done = spawnSync(process.execPath, [bundle, ...args], { encoding: "utf8", env });
      return { code: done.status, out: `${done.stdout}${done.stderr}` };
    };
    const who = "someone@example.com";
    // Looking only: no flag that changes anything, so it runs and changes nothing.
    const look = run(who);
    assert.equal(look.code, 0);
    assert.ok(look.out.includes("Redis: made-up.example.com"), look.out);
    assert.ok(!look.out.includes("CALLED"), look.out);
    // A repair or a clear without --yes-production: refused before anything is called, saying where it points.
    for (const flags of [["--repair"], [`--clear=${who}`], ["--repair", "--yes"], ["--repair", "--yes-productions"]]) {
      const refused = run(who, ...flags);
      assert.equal(refused.code, 3, flags.join(" "));
      assert.ok(!refused.out.includes("CALLED"), `${flags.join(" ")}: ${refused.out}`);
      assert.ok(refused.out.includes("This changes the data at made-up.example.com. Run it again with --yes-production to go on."), refused.out);
    }
    // With it, each does what it was asked, and only that.
    const repaired = run(who, "--repair", "--yes-production");
    assert.deepEqual([repaired.out.includes("CALLED repairMove"), repaired.out.includes("CALLED clearBrokenMoveByHand")], [true, false]);
    const cleared = run(who, `--clear=${who}`, "--yes-production");
    assert.deepEqual([cleared.out.includes("CALLED repairMove"), cleared.out.includes("CALLED clearBrokenMoveByHand")], [false, true]);
    // No address: the usage line, nothing called.
    const bare = run();
    assert.equal(bare.code, 2);
    assert.ok(!bare.out.includes("CALLED"));
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});
