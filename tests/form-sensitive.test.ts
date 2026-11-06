/**
 * 568 [GD2] (c), unit 1: a creator's form never asks for what a scam asks for:
 * a password, a full card number, a card's security code or an identity
 * document's number (lib/form-sensitive.ts). The studio's form save refuses it,
 * naming the field and why (app/api/store/forms/route.ts, components/forms-editor.tsx);
 * nothing is saved and nothing the creator wrote is changed.
 *
 * What fails here: one of these asked and kept; an ordinary question refused
 * ("Your gift card's name", "Your tax ID for the invoice", "PIN code" as a postal
 * code, "What did the password chapter teach you?"); the route or the editor
 * without the refusal.
 */
import { readFileSync } from "node:fs";
import { sensitiveFieldOf, SENSITIVE_WHY } from "@/lib/form-sensitive";
import { parseForm } from "@/lib/forms";
import { done, is, part } from "./check";

const form = (labels: string[]) => parseForm({ id: "aaaaaaaaaa", name: "Sign up", fields: labels.map((label, i) => ({ id: `f${i}xxxx`, type: "short", label, required: false, options: [] })), updatedAt: 1 })!;

part("What a scam asks for is found");
for (const [label, what] of [
  ["Your password", "password"],
  ["Choose a passcode", "password"],
  ["Card number", "card"],
  ["Credit card number", "card"],
  ["Your debit card", "card"],
  ["CVV", "code"],
  ["Security code on the back", "code"],
  ["Social Security number", "id"],
  ["SSN", "id"],
  ["Passport number", "id"],
  ["Driver's license number", "id"],
  ["National ID number", "id"],
] as const) is(`refused: ${label}`, sensitiveFieldOf(form(["Your name", label]))?.what, what);

part("Ordinary questions are not");
for (const label of ["Your name", "Your gift card's name", "Your tax ID for the invoice", "PIN code (postal)", "Which business card style do you like?", "What did the chapter on passwords teach you?", "Your email"]) {
  is(`kept: ${label}`, sensitiveFieldOf(form([label])), null);
}

part("Where it is refused, and how it is said");
const found = sensitiveFieldOf(form(["Your name", "Card number"]))!;
is("the field is named", found.label, "Card number");
is("why, in plain words, for each kind", Object.keys(SENSITIVE_WHY).sort(), ["card", "code", "id", "password"]);
const route = readFileSync("app/api/store/forms/route.ts", "utf8");
is("the save refuses it before writing, naming the field", /sensitiveFieldOf\(form\)[\s\S]{0,200}error: "sensitive"[\s\S]*writeForm\(/.test(route), true);
is("the editor says it", /sensitive:/.test(readFileSync("components/forms-editor.tsx", "utf8")), true);
done();
