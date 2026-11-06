/**
 * The checkout's performance budget (queue item 277 [H3-2]): the browser code
 * of each page a buyer passes through before Stripe, checked statically by
 * scripts/checkout-budget.mjs, so CI fails when one grows past its ceiling,
 * picks up the buy box's code without drawing it, or loads a script from
 * another site. Measurements on a production build, and why the budget is
 * static: docs/checkout-speed-2026-11-06.md.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { done, is, part } from "./check";

type Result = { name: string; route: string; bytes: number; budgetBytes: number; clients: string[]; offSite: string[]; carried: string[]; problems: string[] };

const script = resolve("scripts/checkout-budget.mjs");
// It exits 1 when a budget is broken; the JSON it prints says which, and is what is checked here.
const ran = spawnSync(process.execPath, [script, "--json"], { encoding: "utf8", timeout: 180_000 });
const results = JSON.parse(ran.stdout || "[]") as Result[];
const byName = (name: string) => results.find((r) => r.name === name);

/** The buy box's own browser code (components/store-product.tsx): drawn on the product page, never on /pay or the card on a creator's site. */
const BUY_BOX = ["components/digital-consent-box.tsx", "components/email-field.tsx", "components/pick-bundle-form.tsx", "components/store-cart.tsx"];

part("The three pages before the hand-off to Stripe");
is("the script ran", ran.error ?? null, null);
is("each is measured", results.map((r) => r.route), ["/@handle/p/[product]", "/@handle/pay/[request]", "/embed/[handle]/[product]"]);
for (const r of results) {
  is(`${r.name}: its browser code is within its budget (${r.bytes} of ${r.budgetBytes} gzipped bytes)`, r.bytes > 0 && r.bytes <= r.budgetBytes, true);
  is(`${r.name}: no script from another site`, r.offSite, []);
  is(`${r.name}: nothing it never draws`, r.carried, []);
  is(`${r.name}: the script finds no problem`, r.problems, []);
}
is("the card on a creator's site carries none of the buy box's code", byName("embedded card")?.clients.filter((file) => BUY_BOX.includes(file)), []);
is("nor does the payment request page", byName("payment request page")?.clients.filter((file) => BUY_BOX.includes(file)), []);
is("the product page does carry the buy box it draws", BUY_BOX.every((file) => byName("product page")?.clients.includes(file)), true);

part("The budget can fail");
// The same functions on a page made here: a script from another site, a client
// module it is told it never draws, and a ceiling of one byte.
const fixture = mkdtempSync(join(tmpdir(), "checkout-budget-"));
try {
  mkdirSync(join(fixture, "app"));
  mkdirSync(join(fixture, "components"));
  writeFileSync(join(fixture, "tsconfig.json"), JSON.stringify({ compilerOptions: { jsx: "react-jsx", baseUrl: ".", paths: { "@/*": ["./*"] } } }));
  writeFileSync(join(fixture, "components/drawn.tsx"), '"use client";\nexport function Drawn() {\n  return <button onClick={() => alert("hi")}>Buy</button>;\n}\n');
  writeFileSync(join(fixture, "components/heavy.tsx"), '"use client";\nexport function Heavy() {\n  return <p>{"x".repeat(3)}</p>;\n}\n');
  writeFileSync(join(fixture, "components/many.tsx"), 'import { Heavy } from "@/components/heavy";\nexport const price = "$9";\nexport function Unused() {\n  return <Heavy />;\n}\n');
  writeFileSync(join(fixture, "app/page.tsx"), 'import { Drawn } from "@/components/drawn";\nimport { price } from "@/components/many";\nexport default function Page() {\n  return (\n    <main>\n      <script src="https://example.com/widget.js" />\n      <p>{price}</p>\n      <Drawn />\n    </main>\n  );\n}\n');
  const judged = JSON.parse(
    execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `const { checkBudgets } = await import(${JSON.stringify(pathToFileURL(script).href)});
const [r] = await checkBudgets(${JSON.stringify(fixture)}, [{ name: "fixture", route: "/", entries: ["app/page.tsx"], budgetBytes: 1, keptOut: ["components/heavy.tsx"] }]);
console.log(JSON.stringify(r));`,
      ],
      { encoding: "utf8", timeout: 60_000 },
    ),
  ) as Result;
  is("both client modules are found, through a server module too", judged.clients, ["components/drawn.tsx", "components/heavy.tsx"]);
  is("one byte is over budget", judged.problems.some((p) => p.includes("over its budget of 1")), true);
  is("the module it never draws is named", judged.carried, ["components/heavy.tsx"]);
  is("the script from another site is named", judged.offSite, ["app/page.tsx"]);
} finally {
  rmSync(fixture, { recursive: true, force: true });
}

done();
