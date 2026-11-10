import { sensitiveKindOf, sensitiveFieldOf } from "@/lib/form-sensitive";
import { checkGeneratedCode } from "@/lib/generated-code-check";
import { done, is, part } from "./check";

part("CX1: direct request variants and exact benign exceptions");
for (const label of [
  "Please confirm your passphrase!", "Re enter your passcode", "Reenter your password",
  "Type in your current password", "Provide a new password", "Please choose a new password",
  "Enter your password manager master password", "Enter a password hint followed by your password",
  "Enter your password manager's name and password", "Your password", "Create a passphrase", "New password",
]) {
  is(`sensitive ${label}`, sensitiveKindOf(label), "password");
  const f = { id: "cx1", type: "short" as const, label, required: false, options: [] };
  is(`field ${label}`, sensitiveFieldOf({ fields: [f] })?.what, "password");
}
for (const label of [
  "Enter your password manager's name.", "Enter your password manager’s name?",
  "Choose a password manager!", "Enter a password hint:", "How do you reset your password?",
  "Please describe password safety",
]) is(`ordinary ${label}`, sensitiveKindOf(label), null);
for (const name of ["Please&#32;enter your password", "Please&#x20;provide your passphrase", "Re-enter your passcode"]) {
  const result = checkGeneratedCode({ html: `<input type="text" aria-label="${name}">`, css: "", js: "" });
  is(`generated refused ${name}`, result.staticPass, false);
  is(`generated finding ${name}`, result.findings.some(f => f.rule === "sensitive_field"), true);
}
done();
