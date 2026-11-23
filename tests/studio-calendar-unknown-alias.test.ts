/**
 * #5285 row #3267 (Claude 2's LEVE 6901325796 on #3267): tests/studio-calendar-unknown.test.ts took its next/headers
 * stand-in from a line added to the central list in tests/test-config.mjs, which tests/test-alias-sidecars.test.ts
 * and tests/aliases/README.md forbid (C1-20261107-1232-TODOS-3: central-list edits conflict, and #3267's own merge
 * conflicted on that line). It declares it in its own file, tests/aliases/studio-calendar-unknown.test.ts.json, and
 * gets the same stand-in.
 */
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { testAliases } from "./test-config.mjs";
import { done, is, part } from "./check";

const FILE = "studio-calendar-unknown.test.ts";
const root = resolve(process.cwd());

part("The calendar test's alias lives in its own file, not in the central list");
const central = readFileSync(join(root, "tests/test-config.mjs"), "utf8");
is("RED: the central list no longer names the test", central.includes(`'${FILE}'`), false);
const sidecar = JSON.parse(readFileSync(join(root, "tests/aliases", `${FILE}.json`), "utf8")) as Record<string, unknown>;
is("its own file maps next/headers to the security stand-in", sidecar["next/headers"], "security/next-headers.ts");
const aliases = testAliases(FILE, root, join(root, "tests")) as Record<string, string>;
is("and the test still gets that stand-in", aliases["next/headers"], join(root, "tests", "security/next-headers.ts"));
done();
