import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { done, is, part } from "./check";

// Exercise the actual no-key help entry point; it must finish without a request.
const help = execFileSync(process.execPath, [resolve("cli/marktmorgen.mjs"), "help"], {
  encoding: "utf8", timeout: 10_000, env: { ...process.env, MARKTMORGEN_API_KEY: "" },
});
const readme = readFileSync("cli/README.md", "utf8");

part("Key setup does not put the typed value into a shell command");
for (const [name, text] of [["actual help", help], ["README", readme]]) {
  is(`${name} never asks for an inline exported key`, /\bexport\s+MARKTMORGEN_API_KEY\s*=/.test(text), false);
  is(`${name} reads the key without terminal echo`, /read -r -s -p "Marktmorgen API key: " MARKTMORGEN_API_KEY/.test(text), true);
  is(`${name} exports only the variable name`, /^\s*export MARKTMORGEN_API_KEY\s*$/m.test(text), true);
  is(`${name} tells the user where to type it`, text.includes("Type your key at the prompt"), true);
}
is("help retains the existing tool and paging options", [help.includes("--days 7|30|90"), help.includes("--cursor <next>"), help.includes("Linked resources are never opened or downloaded.")], [true, true, true]);
done();
