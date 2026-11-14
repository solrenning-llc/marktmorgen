/**
 * WCAG 1.3.5 (identify input purpose) on the studio fields that ask the
 * creator for their own details: their name and postal address as the sender
 * of outreach emails, and the postal address at the bottom of each list
 * email. Each says what it is for with the HTML autocomplete token from the
 * list WCAG names (name, street-address), so a browser can fill it and a
 * person's own tools can recognise it. The attribute is static, so each field
 * is read from its source, found by the label that sits with it.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const FIELDS = [
  { file: "components/outreach-studio.tsx", label: "Your name", field: /<input id="out-name"[^>]*>/, token: "name" },
  { file: "components/outreach-studio.tsx", label: "Your postal address", field: /<input id="out-address"[^>]*>/, token: "street-address" },
  { file: "components/email-studio.tsx", label: "Postal address at the bottom of each email", field: /<span className="field-label">Postal address at the bottom of each email<\/span>\s*<input[^>]*>/, token: "street-address" },
];

for (const { file, label, field, token } of FIELDS) {
  const source = readFileSync(file, "utf8");
  assert.ok(source.includes(label), `${file} still asks for "${label}"`);
  const found = source.match(field);
  assert.ok(found, `${file} still has the field for "${label}"`);
  assert.match(found[0], new RegExp(`autoComplete="${token}"`), `"${label}" says its purpose: autocomplete="${token}"`);
}
console.log(`Own details: ${FIELDS.length} fields say their purpose with autocomplete`);
