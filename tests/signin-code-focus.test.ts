/**
 * The login page after the link is asked for, for a keyboard or screen-reader user
 * (issue #4298, creator funnel, Claude 1, 12/11/2026; AX274, WCAG 2.4.3, 3.3.1, 2.2.4, 4.1.3).
 *
 * Found by walking main as a new creator, on this computer, with synthetic services:
 * - after "Email me a link" the pressed button is replaced by "Check that inbox", and the
 *   focus fell to the top of the document;
 * - that whole panel was one live region holding "Send it again in 29s", which changes every
 *   second, so a screen reader could read the count out every second, and the code form's own
 *   alert sat inside it;
 * - a wrong or misshapen 6-digit code switched the button off while it was checked, and the
 *   focus fell to the top of the document instead of staying in the field to type it again.
 * Checked in a browser on the same walk (the focus lands on the title, then on the field after
 * a refused code); here the source keeps the three in place.
 */
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { EmailCodeForm } from "@/components/email-code-form";
import { done, is, part } from "./check";

const form = readFileSync("components/signin-form.tsx", "utf8");
const code = readFileSync("components/email-code-form.tsx", "utf8");

part("After the link is sent");
const sent = form.slice(form.indexOf('if (state.kind === "sent")'), form.indexOf("<form method=\"post\""));
const status = sent.slice(sent.indexOf('<div role="status"'), sent.indexOf("</div>", sent.indexOf('<p className="mt-3 text-sm text-ink-soft">Not there')));
is("the live region holds what was sent, and nothing that changes every second", [status.includes("Check that inbox"), status.includes("Send it again"), status.includes("wait"), status.includes("EmailCodeForm")], [true, false, false, false]);
is("the panel itself is not a live region", /<div role="status" className="text-center">/.test(form), false);
is("the focus goes to its title once the form it replaces is gone", [/ref=\{sentTitle\} tabIndex=\{-1\}/.test(sent), /if \(state\.kind === "sent"\) sentTitle\.current\?\.focus\(\);/.test(form)], [true, true]);

part("A refused code");
is("every refusal goes through one place, which puts the focus back in the field", [
  (code.match(/setProblem\((?!"")[^)]*\)/g) ?? []),
  /const refuse = \(message: string\) => \{\s*setProblem\(message\);\s*field\.current\?\.focus\(\);/.test(code),
  (code.match(/refuse\(/g) ?? []).length >= 4,
], [["setProblem(message)"], true, true]);
const html = renderToStaticMarkup(createElement(EmailCodeForm, { request: "a".repeat(64) }));
is("the field is still the one the refusal is said for", [/role="alert"/.test(html), /autoComplete="one-time-code"|autocomplete="one-time-code"/.test(html)], [true, true]);

done();
