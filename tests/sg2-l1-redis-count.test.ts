/**
 * lib/redis-count.ts: a counter's reply read only in its exact shape
 * (audit SG2, CX-123 rule 24). textCountOf for a GET or an MGET slot (the
 * text Redis keeps, or a number; null is a key that does not exist yet),
 * signedOf for the total DECRBY, INCRBY and HINCRBY answer.
 */
import { signedOf, textCountOf } from "@/lib/redis-count";
import { done, is, part } from "./check";

part("textCountOf: a GET or MGET slot");
is("a missing key is absent, not zero and not unknown", textCountOf(null), "absent");
is("the text Redis keeps", textCountOf("42"), 42);
is("zero as text", textCountOf("0"), 0);
is("a whole number", textCountOf(7), 7);
is("zero", textCountOf(0), 0);
is("the largest safe whole number as text", textCountOf(String(Number.MAX_SAFE_INTEGER)), Number.MAX_SAFE_INTEGER);
for (const [label, reply] of [
  ["undefined (a slot that never came back)", undefined],
  ["an empty text", ""],
  ["a leading zero", "042"],
  ["a sign", "+5"],
  ["a negative as text", "-5"],
  ["a fraction as text", "1.5"],
  ["an exponent", "1e3"],
  ["spaces around it", " 5 "],
  ["words", "five"],
  ["past the safe whole numbers", "9007199254740993"],
  ["a negative number", -1],
  ["a fraction", 0.5],
  ["not a number", Number.NaN],
  ["infinity", Number.POSITIVE_INFINITY],
  ["an unsafe whole number", 2 ** 53],
  ["true", true],
  ["false", false],
  ["an object", { result: "5" }],
  ["a list", ["5"]],
] as [string, unknown][]) {
  is(`${label} is unknown`, textCountOf(reply), null);
}

part("signedOf: a DECRBY, INCRBY or HINCRBY total");
is("a whole number", signedOf(3), 3);
is("zero", signedOf(0), 0);
is("below zero, a take past what was left", signedOf(-4), -4);
for (const [label, reply] of [
  ["null", null],
  ["undefined", undefined],
  ["a count as text", "3"],
  ["a negative as text", "-3"],
  ["a fraction", 0.5],
  ["a negative fraction", -0.5],
  ["not a number", Number.NaN],
  ["infinity", Number.NEGATIVE_INFINITY],
  ["an unsafe whole number", -(2 ** 53)],
  ["true", true],
  ["an object", { result: 3 }],
  ["a list", [3]],
] as [string, unknown][]) {
  is(`${label} is unknown`, signedOf(reply), null);
}

done();
