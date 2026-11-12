import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { done, is, part } from "./check";

// Exercise the actual no-key help entry point; it must finish without a request.
const help = execFileSync(process.execPath, [resolve("cli/marktmorgen.mjs"), "help"], {
  encoding: "utf8", timeout: 10_000, env: { ...process.env, MARKTMORGEN_API_KEY: "" },
});
const readme = readFileSync("cli/README.md", "utf8");
const source = readFileSync("cli/marktmorgen.mjs", "utf8");

part("Key setup does not put the typed value into a shell command");
for (const [name, text] of [["actual help", help], ["README", readme]]) {
  is(`${name} never asks for an inline exported key`, /\bexport\s+MARKTMORGEN_API_KEY\s*=/.test(text), false);
  is(`${name} reads the key without terminal echo`, /read -r -s -p "Marktmorgen API key: " MARKTMORGEN_API_KEY/.test(text), true);
  is(`${name} exports only the variable name`, /^\s*export MARKTMORGEN_API_KEY\s*$/m.test(text), true);
  is(`${name} tells the user where to type it`, text.includes("Type your key at the prompt"), true);
}
is("help retains the existing tool and paging options", [help.includes("--days 7|30|90"), help.includes("--cursor <next>"), help.includes("Linked resources are never opened or downloaded.")], [true, true, true]);

part("The output instructions match a valid plain-text MCP result");
const plainScript = `
const {run}=await import(${JSON.stringify(pathToFileURL(resolve("cli/marktmorgen.mjs")).href)});
let out='',err='',calls=0;
const code=await run(['list_products'],{
 env:{MARKTMORGEN_API_KEY:'nl_live_'+'a'.repeat(40)},
 fetchImpl:async(_url,init)=>{calls++;const request=JSON.parse(init.body);return new Response(JSON.stringify({jsonrpc:'2.0',id:request.id,result:{content:[{type:'text',text:'Synthetic plain text.'}]}}),{status:200});},
 write:value=>{out+=value;},warn:value=>{err+=value;}
});
console.log(JSON.stringify({code,out,err,calls}));
`;
const plain = JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", plainScript], { encoding: "utf8", timeout: 10_000 })) as { code: number; out: string; err: string; calls: number };
is("real CLI keeps valid text without JSON encoding or another request", plain, { code: 0, out: "Synthetic plain text.\n", err: "", calls: 1 });
for (const [name, text] of [["actual help", help], ["README", readme]]) {
  is(`${name} does not promise JSON for every result`, /prints? (?:its|the) answer as JSON/.test(text), false);
  is(`${name} explains text and other content separately`, text.includes("Text results are printed as text. Other content is printed as JSON."), true);
}
is("the usage comment does not promise JSON for every result", source.includes("one tool, its answer as JSON"), false);
done();
