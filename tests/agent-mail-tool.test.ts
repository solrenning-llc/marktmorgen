/**
 * The agent mailbox tool (tooling/agent-mail/): its own tests run here, in CI, and the reviewed SHA-256 is the one the
 * install command in AGENTS.md checks (owner, OWNER-20261121-1904-MAIL-TOOL-FIX-ORDER, step 1). Changing the tool without
 * updating both the hash file and the install command fails this test, so every change goes through a reviewed PR.
 * The tool's tests use local throwaway git repositories and a fake `gh`; nothing real is touched.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { done, is, part } from "./check";
import { relatorio } from "../tooling/agent-mail/audit-cases.mjs";

const tool = readFileSync("tooling/agent-mail/agent-mail.mjs");
const hash = createHash("sha256").update(tool).digest("hex");
const file = readFileSync("tooling/agent-mail/agent-mail.sha256", "utf8");
const agents = readFileSync("AGENTS.md", "utf8");
const co = agents.slice(0, agents.indexOf("\n## ", 1));

part("the reviewed SHA-256");
is("tooling/agent-mail/agent-mail.sha256 is the tool's SHA-256", file, `${hash}  agent-mail.mjs\n`);
is("the install command in AGENTS.md CO (b) checks that same SHA-256", co.includes(`~/.agent-mail/new.mjs ${hash}\``), true);
is("the install command renames the file into place only after the check", /if\(h!==process\.argv\[2\]\)\{console\.error\('SHA-256 diferente: '\+h\);process\.exit\(1\)\}f\.renameSync/.test(co), true);

part("the tool's own tests");
const r = spawnSync(process.execPath, ["tooling/agent-mail/agent-mail.test.mjs", "tooling/agent-mail/agent-mail.mjs"], { encoding: "utf8", timeout: 540_000 });
const total = /(\d+) checks, all passing\./.exec(r.stdout ?? "")?.[1];
is("agent-mail.test.mjs passes", r.status === 0 && Boolean(total), true);
if (r.status !== 0) console.log(`${r.stdout ?? ""}${r.stderr ?? ""}`.slice(-4000));
is("and runs at least 45 checks", Number(total ?? 0) >= 45, true);

part("every case of the independent audit is covered and passing (owner, OWNER-20261121-1904, step 7)");
// The same run, read case by case (tooling/agent-mail/audit-cases.mjs). Against the audited version aff69c9, every case
// fails at least one of its checks: that is the RED before each fix, recorded in tooling/agent-mail/README.md.
const casos = relatorio(r.stdout ?? "");
is("A1 to A15, the proofs of concept 1 and 3 and the API-down case are all listed", casos.map((c) => c.id), ["A1", "A2", "A3", "A4", "A5", "A6", "A7", "A8", "A9", "A10", "A11", "A12", "A13", "A14", "A15", "PoC1", "PoC3", "API"]);
for (const c of casos) is(`${c.id}: at least one check, none failing`, [c.total > 0, c.falham], [true, 0]);

done();
