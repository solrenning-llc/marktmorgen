/** Independent review controls for #2457; no sender, account or browser IO. */
import assert from "node:assert/strict";
import { ACCESS_WORDS, accessWords } from "@/lib/buyer-words/access";
import { LANGUAGE_CODES } from "@/lib/store-language";

let checks = 0;
const inputs = [
  ["https://example.com/harbor/orders", "buyer@example.com", "Harbor Kitchen"],
  ["https://example.com/x?source=a&b=c", "qa+tag@example.com", "Fish & Bread <Store>"],
  ["https://example.com/商店/orders", "person@example.com", "Café 📚"],
];
for (const code of LANGUAGE_CODES) {
  for (const [url, email, store] of inputs) {
    const words = accessWords(code);
    const keys = JSON.stringify(Object.keys(words));
    const text = words.openOrders(url, email, store);
    for (const value of [url, email, store]) {
      assert.ok(text.includes(value));
      checks++;
    }
    assert.equal((text.match(/https:\/\//g) ?? []).length, 1);
    checks++;
    assert.equal(/minut|Minute|minuut|60\s*(seconds|s)\b/.test(text), false);
    checks++;
    assert.equal(JSON.stringify(Object.keys(words)), keys);
    checks++;
  }
}
for (const language of [null, undefined, {}, [], true, 0, "__proto__", "EN", Symbol("language")]) {
  assert.equal(accessWords(language), ACCESS_WORDS.en);
  checks++;
}
console.log(`${checks} independent checks passed`);
