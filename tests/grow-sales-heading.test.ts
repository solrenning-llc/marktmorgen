import assert from "node:assert/strict";
import test from "node:test";
import { isValidElement, type ReactNode } from "react";
import GrowSalesPage from "@/app/grow-sales/page";

function nodes(node: ReactNode): ReactNode[] {
  if (Array.isArray(node)) return node.flatMap(nodes);
  if (!isValidElement<{ children?: ReactNode }>(node)) return [node];
  return [node, ...nodes(node.props.children)];
}

function text(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(text).join("");
  if (!isValidElement<{ children?: ReactNode }>(node)) return "";
  return text(node.props.children);
}

test("the actual growth-page heading offers recorded evidence rather than sales causation", () => {
  const headings = nodes(GrowSalesPage()).filter(node => isValidElement(node) && node.type === "h1");
  assert.equal(headings.length, 1);
  assert.equal(text(headings[0]), "Review your recorded sales.Prepare your next promotion.");
  assert.doesNotMatch(text(headings[0]), /what brings sales|causes? sales|guarantee/i);
});

test("the page keeps the distinction between attributed revenue and proven results", () => {
  const content = text(GrowSalesPage());
  assert.match(content, /A channel with attributed revenue is not proof that advertising caused a sale\./);
  assert.match(content, /A suggested action does not guarantee additional sales\./);
  assert.match(content, /Incomplete financial readings stay unavailable\./);
});
