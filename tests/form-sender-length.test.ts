/**
 * Pre-review proof (Claude 5 on the R19 MEDIUM 1 fix): lib/forms.ts accepts an address by counting its length the way
 * JavaScript does (EMAIL's {1,64} and the slice to 254), so lib/form-respondent.ts must count it the same way. Counted
 * in UTF-8 bytes, 40 "é" before the "@" are 80 bytes, over 64, and the sender the form accepted was not found.
 */
import { parseForm, readAnswers } from "@/lib/forms";
import { emailQuestionIds, isAddress, respondentOf } from "@/lib/form-respondent";
import { done, is } from "./check";

const form = parseForm({ id: "bytesform1", name: "B", fields: [{ id: "email1", type: "email", label: "Your email", required: true }], offerList: true })!;
const typed = "é".repeat(40) + "@example.com";
const read = readAnswers(form, (name) => (name === "q_email1" ? [typed] : []));
is("the form accepts it as the sender's address", read.ok, true);
is("respondentOf names the same sender", read.ok ? respondentOf(emailQuestionIds(form), read.answers) : "x", typed);
const local = "😀".repeat(32) + "@example.com";
is("an emoji counts two, as the form counts it: 32 of them are 64", [formAccepts(local), isAddress(local)], [true, true]);
const over = "😀".repeat(33) + "@example.com";
is("and 33 of them are over 64 for both", [formAccepts(over), isAddress(over)], [false, false]);
done();

function formAccepts(text: string): boolean {
  return readAnswers(form, (name) => (name === "q_email1" ? [text] : [])).ok;
}
