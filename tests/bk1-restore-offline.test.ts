/**
 * 273 [BK1] (inbox C1-20261108-2017-C4-36 items 2 and 7, C1-20261108-1941-C4-35 item 2): two small tools to keep
 * offline beside the owner's export, that need neither the GitHub repository nor the site to run (Node's own modules
 * only):
 *   - scripts/backup-restore-offline.mjs opens a set of .mmbk files (its manifest and every part), checks each part's
 *     size and SHA-256 against the manifest, and by default only counts in memory, writing nothing (the monthly check
 *     of a real set); with --out it writes the rows to one file (here, synthetic rows into a temporary folder only);
 *   - scripts/backup-key-fingerprint.mjs prints a key's fingerprint, so the owner can check the paper copy and the
 *     password manager's against the report, without the key ever being shown.
 * Keys are read from standard input, never from the command line. Synthetic data only.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { copyInParts } from "@/lib/backup-parts";
import * as codec from "@/lib/backup-codec";
import type { BackupObjectStore } from "@/lib/backup-roundtrip";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

// Read through the namespace so this file runs, and fails check by check, on the code before the change.
const backupKeyFingerprint = ((codec as Record<string, unknown>).backupKeyFingerprint ?? (() => "none")) as (key: Uint8Array) => string;

const RESTORE = join(process.cwd(), "scripts/backup-restore-offline.mjs");
const FINGERPRINT = join(process.cwd(), "scripts/backup-key-fingerprint.mjs");
const run = (script: string, args: string[], input: string) => spawnSync(process.execPath, [script, ...args], { input, encoding: "utf8", env: { PATH: process.env.PATH ?? "" } });

async function main(): Promise<void> {
  const oldKey = Buffer.alloc(32, 3);
  const newKey = Buffer.alloc(32, 4);
  const dir = mkdtempSync(join(tmpdir(), "bk1-offline-"));
  try {
    part("The tools need nothing but Node's own modules");
    for (const script of [RESTORE, FINGERPRINT]) {
      const source = existsSync(script) ? readFileSync(script, "utf8") : "";
      const imports = [...source.matchAll(/^\s*import\s[^;]*?from\s+["']([^"']+)["']/gm)].map((m) => m[1]);
      is(`${script.split("/").pop()}: exists, and imports only node: modules`, [source.length > 0, imports.length > 0 && imports.every((name) => name.startsWith("node:"))], [true, true]);
    }

    part("A synthetic set in three parts, sealed under the previous key, opened offline");
    redis.clear();
    for (let i = 0; i < 30; i += 1) redis.run(["SET", `nl:synthetic:k${String(i).padStart(2, "0")}`, `value ${i} `.repeat(40)]);
    redis.run(["SET", "nl:synthetic:ends", "soon", "PX", 3_600_000]);
    const objects = new Map<string, Uint8Array>();
    const store: BackupObjectStore = { putNew: async (id, bytes) => void objects.set(id, new Uint8Array(bytes)), read: async (id) => objects.get(id)! };
    const now = Date.now();
    const made = await copyInParts({ maxRows: 1_000, maxCommands: 1_000, maxParts: 10, maxRunBytes: 1_000_000, batch: 10, now, partBytes: 5_000 }, oldKey, store);
    is("the set is made in more than one part", made.ok && made.parts > 1, true);
    for (const [id, bytes] of objects) writeFileSync(join(dir, `${id}.mmbk`), bytes);
    const manifestId = made.ok ? made.id : "";
    const keys = `${newKey.toString("base64")}\n${oldKey.toString("base64")}\n`;

    const check = run(RESTORE, [dir, manifestId], keys);
    const summary = check.status === 0 ? JSON.parse(check.stdout) : null;
    is("check only: done, with the manifest's counts, the key id that opened it, and nothing written", [check.status, summary?.rows, summary?.parts, summary?.kid, readdirSync(dir).length], [0, 31, made.ok ? made.parts : -1, backupKeyFingerprint(oldKey), objects.size]);
    is("its output names no key and no value", /value \d|AAAA/.test(check.stdout), false);

    const out = join(dir, "restored.json");
    const write = run(RESTORE, [dir, manifestId, "--out", out], keys);
    const restored = write.status === 0 && existsSync(out) ? (JSON.parse(readFileSync(out, "utf8")) as { rows: { key: string; dump: string; expiresAt: number | null }[] }) : null;
    is("with --out: every row written to that one file, synthetic only", [write.status, restored?.rows.length, restored?.rows.every((row) => row.key.startsWith("nl:synthetic:"))], [0, 31, true]);
    is("the key with an end keeps its absolute end", typeof restored?.rows.find((row) => row.key === "nl:synthetic:ends")?.expiresAt, "number");
    const again = run(RESTORE, [dir, manifestId, "--out", out], keys);
    is("never over a file that is there", [again.status !== 0, existsSync(out) && readFileSync(out, "utf8").length > 0], [true, true]);

    part("Anything wrong stops it, before a byte is written");
    is("without the key that sealed it: refused", run(RESTORE, [dir, manifestId], `${newKey.toString("base64")}\n`).status !== 0, true);
    const firstPart = [...objects.keys()].find((id) => id !== manifestId)!;
    const changed = Buffer.from(objects.get(firstPart)!);
    changed[changed.length - 1] ^= 1;
    writeFileSync(join(dir, `${firstPart}.mmbk`), changed);
    const out2 = join(dir, "never.json");
    const bad = run(RESTORE, [dir, manifestId, "--out", out2], keys);
    is("a part that differs from its manifest: refused, nothing written", [bad.status !== 0, existsSync(out2)], [true, false]);
    writeFileSync(join(dir, `${firstPart}.mmbk`), objects.get(firstPart)!);
    rmSync(join(dir, `${firstPart}.mmbk`));
    is("a part missing: refused", run(RESTORE, [dir, manifestId], keys).status !== 0, true);
    is("a manifest id that is not one: refused", run(RESTORE, [dir, "../etc/passwd"], keys).status !== 0, true);
    is("a key on the command line is never taken", run(RESTORE, [dir, manifestId, oldKey.toString("base64")], "").status !== 0, true);

    part("The fingerprint, from standard input");
    const printed = run(FINGERPRINT, [], `${newKey.toString("base64")}\n`);
    is("the same 8 hex as the report", [printed.status, printed.stdout.trim()], [0, backupKeyFingerprint(newKey)]);
    is("a key that is not 32 bytes: refused, nothing printed", (() => {
      const r = run(FINGERPRINT, [], Buffer.alloc(16, 1).toString("base64"));
      return [r.status !== 0, r.stdout.trim()];
    })(), [true, ""]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
