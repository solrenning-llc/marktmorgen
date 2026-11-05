/**
 * Independent review proof for #2625 at 27f81ea0134977423e64426f9e147961315ef4b3.
 *
 * It leaves the author's files untouched: the frozen scenario is inserted in
 * memory into the unchanged team scheduling test, bundled with the repository's
 * real test aliases, and run against the real calls/team-booking functions.
 */
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { build } from "esbuild";
import { testAliases, testEnvironment } from "../tests/test-config.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const tests = join(root, "tests");
const sourcePath = join(tests, "team-scheduling.test.ts");
const callsPath = join(root, "lib/calls.ts");
const source = readFileSync(sourcePath, "utf8");
const calls = readFileSync(callsPath, "utf8");
const blob = (text) => createHash("sha1").update(`blob ${Buffer.byteLength(text)}\0`).update(text).digest("hex");

const expected = {
  test: "a53f89064bbdc2cdac626723426670e373e6e530",
  calls: "9849f89059aa3212efc9a9767c2c9e853cffe212",
};
const actual = { test: blob(source), calls: blob(calls) };
if (actual.test !== expected.test || actual.calls !== expected.calls) {
  throw new Error(`Proof sources changed: ${JSON.stringify({ expected, actual })}`);
}

const marker = '  part("When her calendar cannot be read");';
const scenario = String.raw`
  part("An unreadable saved team never becomes an ordinary move");
  const guarded = await storeWithCalls("guarded@example.com", "guarded", "acct_1TestGuarded001", "pro", 1);
  const [guardedCall] = guarded.products;
  await writeTeam(guarded.store, guardedCall.id, { mode: "round_robin", hosts: [host("guarded@example.com")], createdAt: "2026-10-08T00:00:00.000Z" });
  const guardedStart = weekdayAt(11, 600);
  const guardedHold = await hold(guarded.store, guardedCall, guardedStart);
  if (!guardedHold.ok) throw new Error("no hold on the guarded call");
  await confirmBooking({ store: guarded.store, product: guardedCall, session: guardedHold.session, start: guardedStart, end: guardedStart + HOUR, buyerEmail: "jo@example.com", buyerTz: NY, origin: "https://marktmorgen.com" });
  await writeTeam(guarded.store, guardedCall.id, {} as TeamSetup);
  is("the invalid configured team is closed", await activeTeam(guarded.store, guardedCall), "closed");
  const guardedOffers = ((await slotsForMove(guarded.store, guardedCall, guardedHold.session, guardedStart, HOUR))?.days ?? []).flatMap((day) => day.starts);
  is("its existing team booking gets no ordinary-store move offers", guardedOffers.length, 0);
  const guardedMove = await moveBooking({ store: guarded.store, product: guardedCall, session: guardedHold.session, booked: { start: guardedStart, end: guardedStart + HOUR, email: "jo@example.com", buyerTz: NY }, start: guardedStart + 2 * HOUR, origin: "https://marktmorgen.com" });
  const [guardedRaw] = await redisPipeline([["HGET", "nl:call:busy:" + guarded.store.callsId, guardedHold.session]]);
  const guardedEntry = typeof guardedRaw === "string" ? JSON.parse(guardedRaw) as { h?: unknown; c?: unknown } : {};
  is("it cannot move as ordinary or lose its recorded hosts", [guardedMove.ok, Array.isArray(guardedEntry.h), typeof guardedEntry.c], [false, true, "string"]);

`;
if (!source.includes(marker) || source.indexOf(marker) !== source.lastIndexOf(marker)) throw new Error("Proof insertion marker changed");
const proof = source.replace(marker, `${scenario}${marker}`);
const out = mkdtempSync(join(tmpdir(), "j-review-2625-"));
try {
  const bundle = join(out, "team-scheduling.test.cjs");
  await build({
    stdin: { contents: proof, resolveDir: tests, sourcefile: "team-scheduling.test.ts", loader: "ts" },
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile: bundle,
    logLevel: "error",
    alias: testAliases("team-scheduling.test.ts", root, tests),
  });
  console.log(JSON.stringify({ review: "#2625", head: "27f81ea0134977423e64426f9e147961315ef4b3", sources: actual }));
  const run = spawnSync(process.execPath, [bundle], { stdio: "inherit", env: testEnvironment(process.env) });
  process.exitCode = run.status ?? 1;
} finally {
  rmSync(out, { recursive: true, force: true });
}
