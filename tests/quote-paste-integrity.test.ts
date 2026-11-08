import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const { transformSync } = createRequire(path.resolve("package.json"))("esbuild") as typeof import("esbuild");
import { pasteExceedsLimit } from "@/lib/paste-limit";
import { itemAddId, itemRemoveId } from "@/lib/block-insert";
import { is, done } from "./check";

is("400 units fit", pasteExceedsLimit("", 0, 0, "a".repeat(400), 400), false);
is("401 units are refused whole", pasteExceedsLimit("", 0, 0, "a".repeat(401), 400), true);
is("selection replacement is counted", pasteExceedsLimit("a".repeat(400), 0, 10, "b".repeat(10), 400), false);
is("surrogate pairs use browser units", pasteExceedsLimit("", 0, 0, "😀".repeat(201), 400), true);
is("Windows newlines normalize", pasteExceedsLimit("", 0, 0, "a\r\nb", 3), false);
is("invalid selection is refused", pasteExceedsLimit("text", 3, 1, "new", 400), true);

const source = fs.readFileSync(path.resolve("components/page-editor.tsx"), "utf8");
const start = source.indexOf("function QuotesEditor(");
const end = source.indexOf("\nfunction ", start + 10);
assert.ok(start >= 0 && end > start);
const code = transformSync("export " + source.slice(start, end), { loader: "tsx", format: "cjs", jsx: "automatic", target: "es2022" }).code;
let blocked = false;
const jsx = (type: unknown, props: unknown) => ({ type, props });
const mod = { exports: {} as { QuotesEditor?: (props: unknown) => unknown } };
const wrapper = vm.runInNewContext("(function(require,module,exports,useState,pasteExceedsLimit,MAX_QUOTE,MAX_QUOTES,MAX_QUOTE_NAME,MAX_QUOTE_URL,quoteUrl,Icon,itemRemoveId,itemAddId,focusItemAfterRemoval){" + code + "\n})");
wrapper((name: string) => { assert.equal(name, "react/jsx-runtime"); return { jsx, jsxs: jsx, Fragment: "fragment" }; },
  mod, mod.exports, () => [blocked, (value: boolean) => { blocked = value; }], pasteExceedsLimit, 400, 6, 80, 2000, () => true, "icon", itemRemoveId, itemAddId, () => {});
type Node = { type?: string; props?: { children?: unknown; [key: string]: unknown } };
function nodes(value: unknown): Node[] {
  if (!value || typeof value !== "object") return [];
  if (Array.isArray(value)) return value.flatMap(nodes);
  const node = value as Node;
  return [node, ...nodes(node.props?.children)];
}
let changes = 0;
const original = "a".repeat(399);
const render = () => mod.exports.QuotesEditor!({ base: "quote", items: [{ text: original, name: "", url: "https://example.com/review" }], onChange: () => { changes++; } });
let field = nodes(render()).find(node => node.type === "textarea")!;
function paste(text: string, start = 399, end = 399) {
  let prevented = false;
  (field.props!.onPaste as (event: unknown) => void)({ currentTarget: { value: original, selectionStart: start, selectionEnd: end }, clipboardData: { getData: (format: string) => { assert.equal(format, "text/plain"); return text; } }, preventDefault: () => { prevented = true; } });
  return prevented;
}
is("actual handler refuses excess before onChange", paste("xy"), true);
is("refusal never writes a clipped quotation", changes, 0);
is("the controlled field keeps its full original", field.props!.value, original);
is("refusal renders an accessible alert", nodes(render()).some(node => node.props?.role === "alert"), true);
is("valid selection replacement is allowed", paste("xy", 397, 399), false);
is("valid paste clears the refusal alert", nodes(render()).some(node => node.props?.role === "alert"), false);
is("empty clipboard leaves normal browser behavior", paste(""), false);
paste("too long");
field = nodes(render()).find(node => node.type === "textarea")!;
(field.props!.onChange as (event: unknown) => void)({ target: { value: "complete words" } });
is("manual change reaches the existing editor", changes, 1);
is("manual change clears the notice", nodes(render()).some(node => node.props?.role === "alert"), false);
done();
