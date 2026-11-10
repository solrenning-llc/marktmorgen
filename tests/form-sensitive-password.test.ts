/** GD2(c): direct requests to enter a password are refused before saving a form. */
import { sensitiveFieldOf, sensitiveKindOf } from "@/lib/form-sensitive";
import { checkGeneratedCode } from "@/lib/generated-code-check";
import { done, is, part } from "./check";

part("Direct requests for a visitor's password are refused");
for (const label of [
  "Please enter your password",
  "Enter your password",
  "Enter a password",
  "Please provide your password",
  "Provide your passcode",
  "Type your passphrase",
  "Type in your password",
  "Create your password",
  "Choose a password",
  "Confirm your password",
  "Re-enter your password",
  "Please enter your account password",
  "Enter your email password",
  "Enter your current password",
  "Enter your new password",
  "  PLEASE ENTER YOUR PASSWORD:  ",
  "Please\tenter\nyour password",
  "Please enter your password manager's password",
] as const) {
  is(`refused: ${label}`, sensitiveKindOf(label), "password");
  const field = { id: "field1", type: "short" as const, label, required: true, options: [] };
  is(`form names the refused field: ${label}`, sensitiveFieldOf({ fields: [field] }), { label: label.trim(), what: "password" });
}

part("Questions about passwords and ordinary instructions remain available");
for (const label of [
  "What did the chapter on passwords teach you?",
  "How do you choose a password?",
  "Please enter your email",
  "Enter your password manager's name",
  "Enter a password hint",
  "Choose a password manager",
  "Please provide your feedback about password safety",
  "Describe how to create a password",
  "Please enter your postal code",
  "Type your name",
]) is(`kept: ${label}`, sensitiveKindOf(label), null);

part("Generated forms use the same refusal for labels and accessible input names");
for (const html of [
  '<label>Please enter your password<input type="text"></label>',
  '<input type="text" aria-label="Please provide your password">',
  '<input type="text" placeholder="Type your passphrase">',
]) {
  const result = checkGeneratedCode({ html, css: "", js: "" });
  is("a direct password request cannot pass the generated-code check", result.staticPass, false);
  is("the password request is identified", result.findings.some((finding) => finding.rule === "sensitive_field"), true);
}

done();
