import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { ASSISTANT_ON_SALE, PLANS_ON_SALE } from "@/lib/opening";
import { renderMarginAlignment } from "./margin-alignment-table";

test("restored LLC categories regenerate the complete margin document with the actual generator", () => {
 // Generated on demand (owner, 20/11/2026): the generator prints the report, and it is the one the table renders today.
 const generated = spawnSync(process.execPath, ["scripts/margin-alignment.mjs"], { cwd: process.cwd(), encoding: "utf8", env: process.env, maxBuffer: 16 * 1024 * 1024 });
 assert.equal(generated.status, 0, generated.stderr);
 assert.equal(generated.stdout, renderMarginAlignment(PLANS_ON_SALE, ASSISTANT_ON_SALE));
 assert.ok(generated.stdout.includes("| itin-and-acceptance-agent | unknown | unknown |"));
 assert.ok(generated.stdout.includes("| us-resident-representative | unknown | unknown |"));
});
