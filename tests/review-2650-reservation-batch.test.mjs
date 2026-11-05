import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const expected =
  "| Codex M | ciclo146/CX123(30): keep checkout-question controls honest before hydration | codex/m-checkout-fields-hydration-guard | \`components/checkout-fields-editor.tsx\`, new \`tests/checkout-fields-hydration-readiness.test.ts\` | 05/11/2026 |";

test("the central batch includes the checkout-fields reservation announced before it opened", () => {
  const reservations = readFileSync("docs/reservations/codex.md", "utf8");
  assert.ok(
    reservations.split("\n").includes(expected),
    "the announced checkout-fields reservation is missing from the central batch",
  );
});
