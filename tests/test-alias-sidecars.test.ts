/**
 * Claude 1's unit (C1-20261107-1232-TODOS-3, 2): a pull request that needs
 * test aliases for its own test must not edit the central list in
 * tests/test-config.mjs, where every such pull request appended a line just
 * before `return aliases;` and two of them conflicted (the conflict that took
 * #2657 out of the merge queue). A test declares its aliases in its own file,
 * tests/aliases/<test file>.json, read by testAliases after the central list.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { testAliases } from "./test-config.mjs";
import { done, is, part } from "./check";

const root = resolve(process.cwd());
const scratch = mkdtempSync(join(tmpdir(), "alias-sidecars-"));
const here = join(scratch, "tests");
mkdirSync(join(here, "aliases"), { recursive: true });
for (const name of ["a-world.ts", "b-world.ts"]) writeFileSync(join(here, name), "export {};\n");

function aliasesOf(file: string, sidecar?: unknown): Record<string, string> {
  if (sidecar !== undefined) writeFileSync(join(here, "aliases", `${file}.json`), JSON.stringify(sidecar));
  return testAliases(file, root, here) as Record<string, string>;
}
function thrown(run: () => unknown): string {
  try {
    run();
    return "";
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

try {
  part("Two pull requests, each with the aliases of its own test");
  {
    const a = aliasesOf("zz-sim-a.test.ts", { "@/lib/studio-route": "a-world.ts", "next/headers": "a-world.ts" });
    const b = aliasesOf("zz-sim-b.test.ts", { "@/lib/studio-route": "b-world.ts" });
    is("A's test gets A's aliases", [a["@/lib/studio-route"], a["next/headers"]], [join(here, "a-world.ts"), join(here, "a-world.ts")]);
    is("B's test gets B's, and not A's next/headers", [b["@/lib/studio-route"], b["next/headers"]], [join(here, "b-world.ts"), undefined]);
    is("a test with no file of its own keeps only the central list", aliasesOf("zz-sim-c.test.ts")["@/lib/studio-route"], undefined);
  }

  part("Merged together, the two pull requests do not touch the same line");
  {
    // The old way: both append an entry at the same place in the central list. git merge-file conflicts.
    const central = readFileSync(join(root, "tests/test-config.mjs"), "utf8");
    const at = central.lastIndexOf(" return aliases;");
    const withLine = (line: string) => central.slice(0, at) + line + "\n" + central.slice(at);
    const dir = join(scratch, "merge");
    mkdirSync(dir);
    writeFileSync(join(dir, "base"), central);
    writeFileSync(join(dir, "a"), withLine(" if(file==='zz-sim-a.test.ts')aliases['@/lib/studio-route']=join(here,'a-world.ts');"));
    writeFileSync(join(dir, "b"), withLine(" if(file==='zz-sim-b.test.ts')aliases['@/lib/studio-route']=join(here,'b-world.ts');"));
    let conflicts = 0;
    try {
      execFileSync("git", ["merge-file", "-p", join(dir, "a"), join(dir, "base"), join(dir, "b")], { stdio: ["ignore", "pipe", "ignore"] });
    } catch (error) {
      conflicts = (error as { status?: number }).status ?? -1;
    }
    is("editing the central list, the two pull requests conflict", conflicts > 0, true);
    // The new way: each pull request adds only its own file, so the central list is the same in both.
    const touched = (test: string) => [`tests/aliases/${test}.json`];
    const shared = touched("zz-sim-a.test.ts").filter((path) => touched("zz-sim-b.test.ts").includes(path));
    is("with a file per test, they share no file", shared, []);
    is("and neither touches tests/test-config.mjs", [...touched("zz-sim-a.test.ts"), ...touched("zz-sim-b.test.ts")].includes("tests/test-config.mjs"), false);
  }

  part("What a test's file may say");
  {
    const fromRoot = aliasesOf("zz-sim-root.test.ts", { "@/lib/redis": "@/lib/redis.ts" });
    is('a target starting "@/" is read from the repository root', fromRoot["@/lib/redis"], join(root, "lib/redis.ts"));
    is("the central default is there without a file of its own", typeof aliasesOf("zz-sim-c.test.ts")["@/lib/resend-fallback-transport"], "string");
    const removed = aliasesOf("zz-sim-null.test.ts", { "@/lib/resend-fallback-transport": null });
    is("null takes a central default away for that test only", "@/lib/resend-fallback-transport" in removed, false);
    is("a target that does not exist is refused by name", thrown(() => aliasesOf("zz-sim-missing.test.ts", { "@/lib/ai": "no-such-world.ts" })).includes("no-such-world.ts"), true);
    is("a value that is not a path or null is refused", thrown(() => aliasesOf("zz-sim-number.test.ts", { "@/lib/ai": 7 })) !== "", true);
    is("a file that is not one object is refused", thrown(() => aliasesOf("zz-sim-list.test.ts", ["@/lib/ai"])) !== "", true);
    writeFileSync(join(here, "aliases", "zz-sim-broken.test.ts.json"), "{ not json");
    is("a file that does not parse is refused", thrown(() => testAliases("zz-sim-broken.test.ts", root, here)) !== "", true);
  }
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
done();
