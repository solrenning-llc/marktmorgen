import assert from "node:assert/strict";
import test from "node:test";
import { newCertificateId } from "@/lib/certificate";
import { newItemId } from "@/lib/course";

function draw(make: () => string, first: number) {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis.crypto, "getRandomValues");
  let calls = 0;
  Object.defineProperty(globalThis.crypto, "getRandomValues", {
    configurable: true,
    value: <T extends ArrayBufferView | null>(array: T): T => {
      calls++;
      (array as unknown as Uint8Array).fill(calls === 1 ? first : 0);
      return array;
    },
  });
  try { return { id: make(), calls }; }
  finally {
    if (descriptor) Object.defineProperty(globalThis.crypto, "getRandomValues", descriptor);
    else Reflect.deleteProperty(globalThis.crypto, "getRandomValues");
  }
}

for (const [name, make, length] of [["certificate", newCertificateId, 16], ["course item", newItemId, 12]] as const) {
  test(`control: ${name} retains its alphabet and length on accepted zero bytes`, () => {
    assert.deepEqual(draw(make, 0), { id: "a".repeat(length), calls: 1 });
  });
  test(`${name} rejects the incomplete byte tail before choosing a letter`, () => {
    // With36 letters, bytes252..255 cannot join an equal-sized partition.
    // The next actual source draw supplies accepted zero bytes.
    assert.deepEqual(draw(make, 255), { id: "a".repeat(length), calls: 2 });
  });
}
