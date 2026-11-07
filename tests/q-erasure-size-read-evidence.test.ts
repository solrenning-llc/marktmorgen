/**
 * CX-123 rule 24: a deletion's paid ceiling uses only exact, known counts.
 * An omitted family means that family was not part of this estimate and is
 * the known zero. A present value of another type or outside the count domain
 * is unknown; it must not be coerced to zero (or to another integer).
 */
import { ERASE_FIXED_BYTES, ERASE_FIXED_COMMANDS, ERASE_PER, erasureWork } from "@/lib/erasure-rules";
import { done, is, part } from "./check";

const tried = (value: unknown): "accepted" | "refused" => {
  try {
    erasureWork({ deals: value } as never);
    return "accepted";
  } catch {
    return "refused";
  }
};

part("Known deletion sizes");
is("an omitted family is the known zero", erasureWork({}), {
  commands: ERASE_FIXED_COMMANDS,
  bytes: ERASE_FIXED_BYTES,
});
is("an exact non-negative integer is counted", erasureWork({ deals: 2 }), {
  commands: ERASE_FIXED_COMMANDS + ERASE_PER.deals[0] * 2,
  bytes: ERASE_FIXED_BYTES + ERASE_PER.deals[1] * 2,
});

part("Unknown deletion sizes never become zero or another count");
for (const [name, value] of [
  ["numeric text", "7"],
  ["null", null],
  ["explicit undefined", undefined],
  ["NaN", Number.NaN],
  ["infinity", Number.POSITIVE_INFINITY],
  ["negative", -1],
  ["fraction", 1.5],
  ["work overflow", Number.MAX_SAFE_INTEGER],
  ["unsafe integer", Number.MAX_SAFE_INTEGER + 1],
] as const) {
  is(`${name} is refused`, tried(value), "refused");
}

done();
