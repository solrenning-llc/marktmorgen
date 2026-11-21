/**
 * 607 [WP6], unit 1: the store's name on the buyer's card statement, as pure
 * rules (no Stripe call, no Redis). A charge the buyer does not recognise is
 * the commonest reason for a "not recognised" dispute; the suffix puts the
 * store's own name after the creator's account prefix.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  descriptorText,
  MIN_SUFFIX_LENGTH,
  PREFIX_MAX,
  SEPARATOR_ROOM,
  STATEMENT_DESCRIPTOR_MAX,
  statementSuffix,
  SUFFIX_PARAM,
  suffixParams,
} from "@/lib/statement-descriptor";

test("a store's name goes after the account's prefix, joined by the separator", () => {
  const decision = statementSuffix("Yoga Flow", "JANESMITH");
  assert.deepEqual(decision, { kind: "send", suffix: "Yoga Flow", full: "JANESMITH* Yoga Flow" });
});

test("the whole descriptor, prefix and separator included, never passes 22 characters", () => {
  assert.equal(STATEMENT_DESCRIPTOR_MAX, 22);
  assert.equal(SEPARATOR_ROOM, 2);
  const names = [
    "Yoga Flow Academy for Busy Parents",
    "A",
    "The Very Long Name Of A Store That Sells Courses",
    "Supercalifragilisticexpialidocious",
    "Jo Jo Jo Jo Jo Jo Jo Jo Jo Jo Jo Jo",
    "Café Ñandú & Hermanos",
  ];
  let sent = 0;
  for (let length = 1; length <= STATEMENT_DESCRIPTOR_MAX; length++) {
    const prefix = "P".repeat(length);
    for (const name of names) {
      const decision = statementSuffix(name, prefix);
      if (decision.kind !== "send") continue;
      sent++;
      assert.ok(decision.full.length <= STATEMENT_DESCRIPTOR_MAX, `${decision.full} is ${decision.full.length} long`);
      assert.equal(decision.full, `${prefix}* ${decision.suffix}`);
      assert.ok(decision.suffix.length >= MIN_SUFFIX_LENGTH);
    }
  }
  assert.ok(sent > 0, "some names must be sent");
});

test("only plain letters, digits and single spaces are ever sent: never < > \\ ' \" * or any other sign", () => {
  const decision = statementSuffix(`Jane's <Shop> "Best" * \\ & Co. / 50%`, "JS");
  assert.equal(decision.kind, "send");
  if (decision.kind !== "send") return;
  assert.match(decision.suffix, /^[A-Za-z0-9]+( [A-Za-z0-9]+)*$/);
  // An apostrophe is dropped inside a word; every other sign becomes a space.
  assert.equal(decision.suffix, "Janes Shop Best Co");
  for (const sign of ["<", ">", "\\", "'", '"', "*", "&", ".", "/", "%"]) assert.ok(!decision.suffix.includes(sign), sign);
});

test("accents are folded to their plain letters; other scripts are dropped", () => {
  assert.equal(descriptorText("Café Ñandú"), "Cafe Nandu");
  assert.equal(descriptorText("  Zoë   Brontë\tStudio\n"), "Zoe Bronte Studio");
  assert.equal(descriptorText("東京 Yoga"), "Yoga");
  assert.equal(descriptorText("🌿🌿"), "");
});

test("an unknown or empty prefix is never guessed: nothing is sent", () => {
  for (const prefix of [null, undefined, "", "   ", 42, {}, "X".repeat(STATEMENT_DESCRIPTOR_MAX + 1)]) {
    assert.deepEqual(statementSuffix("Yoga Flow", prefix), { kind: "skip", reason: "prefix-unknown" }, String(prefix));
  }
});

test("a name with no plain letter, or no name at all, sends nothing", () => {
  assert.deepEqual(statementSuffix("12345", "JS"), { kind: "skip", reason: "no-letter" });
  assert.deepEqual(statementSuffix("東京ヨガ", "JS"), { kind: "skip", reason: "no-letter" });
  assert.deepEqual(statementSuffix("", "JS"), { kind: "skip", reason: "no-letter" });
  assert.deepEqual(statementSuffix(undefined, "JS"), { kind: "skip", reason: "no-letter" });
  assert.deepEqual(statementSuffix(null, "JS"), { kind: "skip", reason: "no-letter" });
  assert.deepEqual(statementSuffix("A", "JS"), { kind: "skip", reason: "too-short" });
});

test("a long name is cut at a word when one fits, otherwise at the room left", () => {
  // Prefix of 10 leaves 22 - 10 - 2 = 10.
  assert.deepEqual(statementSuffix("Yoga Flow Academy", "ABCDEFGHIJ"), {
    kind: "send",
    suffix: "Yoga Flow",
    full: "ABCDEFGHIJ* Yoga Flow",
  });
  assert.deepEqual(statementSuffix("Supercalifragilistic", "ABCDEFGHIJ"), {
    kind: "send",
    suffix: "Supercalif",
    full: "ABCDEFGHIJ* Supercalif",
  });
  // Exactly the room: kept whole.
  assert.deepEqual(statementSuffix("Yoga Flows", "ABCDEFGHIJ"), {
    kind: "send",
    suffix: "Yoga Flows",
    full: "ABCDEFGHIJ* Yoga Flows",
  });
});

test("a prefix in a shape Stripe does not give is unknown, never a verified prefix (Codex H2 on #3594)", () => {
  // Stripe's shortened prefix: 2 to 10 characters, at least one letter, none of < > \\ ' " * (docs.stripe.com/get-started/account/statement-descriptors, read by Codex H2 on 10 November 2026).
  for (const prefix of ["1", "12", "A", "A*B", "A<B", "A>B", "A\\B", "A'B", 'A"B', "AB\nCD", "AB\tCD", "ABCDEFGHIJK", " ABC", "ABC "]) {
    assert.deepEqual(statementSuffix("Yoga Flow", prefix), { kind: "skip", reason: "prefix-unknown" }, JSON.stringify(prefix));
  }
  for (const prefix of ["JS", "J SMITH", "J.SMITH", "ABCDEFGHIJ", "SHOP 24"]) {
    assert.equal(statementSuffix("Yoga Flow", prefix).kind, "send", JSON.stringify(prefix));
  }
});

test("a prefix that leaves no useful room sends nothing", () => {
  // Stripe gives no prefix longer than PREFIX_MAX (10): a longer one is unknown before any room is counted.
  assert.equal(PREFIX_MAX, 10);
  for (const length of [11, 18, 19, 20, STATEMENT_DESCRIPTOR_MAX]) {
    assert.deepEqual(statementSuffix("Yoga Flow", "X".repeat(length)), { kind: "skip", reason: "prefix-unknown" }, String(length));
  }
  // The longest prefix leaves 10 characters, cut at a whole word.
  assert.equal(MIN_SUFFIX_LENGTH, 2);
  assert.deepEqual(statementSuffix("Yoga Flow", "X".repeat(PREFIX_MAX)), { kind: "send", suffix: "Yoga Flow", full: `${"X".repeat(PREFIX_MAX)}* Yoga Flow` });
  // A cut that leaves less than the minimum still sends nothing.
  assert.deepEqual(statementSuffix("A Bcdefghijklmnop", "X".repeat(PREFIX_MAX)), { kind: "skip", reason: "no-room" });
});

test("a name the prefix already shows is not repeated", () => {
  assert.deepEqual(statementSuffix("Yoga Flow", "YOGA FLOW"), { kind: "skip", reason: "in-prefix" });
  assert.deepEqual(statementSuffix("flow", "YOGA FLOW"), { kind: "skip", reason: "in-prefix" });
  assert.equal(statementSuffix("Yoga Flow Studio", "YOGA").kind, "send");
  // Cut to the room first: "Yoga Flow Studio" after "YOGA FLOW" leaves "Yoga Flow", already shown.
  assert.deepEqual(statementSuffix("Yoga Flow Studio", "YOGA FLOW"), { kind: "skip", reason: "in-prefix" });
});

test("the parameter goes only on a one-time payment, and only when there is something to send", () => {
  assert.equal(SUFFIX_PARAM, "payment_intent_data[statement_descriptor_suffix]");
  const send = statementSuffix("Yoga Flow", "JANESMITH");
  assert.deepEqual(suffixParams("payment", send), { [SUFFIX_PARAM]: "Yoga Flow" });
  // Checkout's payment_intent_data is for payment mode only; subscription
  // and setup sessions take no suffix there.
  assert.deepEqual(suffixParams("subscription", send), {});
  assert.deepEqual(suffixParams("setup", send), {});
  assert.deepEqual(suffixParams("payment", statementSuffix("Yoga Flow", null)), {});
});
