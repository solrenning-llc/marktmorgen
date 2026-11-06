/**
 * 568 [GD2] (h): every action that cannot be undone asks first (WCAG 3.3.4, 3.3.6
 * at AAA). The audit of 1 November 2026 found four that did not: deleting a blog
 * post, deleting an agreement, removing the license keys not yet given and
 * removing a webhook endpoint. Each now goes through ConfirmAction
 * (components/confirm-action.tsx): the first press asks what will happen; only
 * "Yes, …" does it; "Keep it", focused, puts it back.
 *
 * What fails here: one of the four acting on its first press again; the
 * component doing it without the second press, or without saying what happens.
 */
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement, type ComponentProps, type FunctionComponent } from "react";
import { ConfirmAction } from "@/components/confirm-action";
import { done, is, part } from "./check";

part("The component asks before it acts");
let acted = 0;
// The button's words go in as children, the third argument, as JSX would put them.
const Confirm = ConfirmAction as FunctionComponent<Omit<ComponentProps<typeof ConfirmAction>, "children">>;
const first = renderToStaticMarkup(createElement(Confirm, { question: "Delete this post?", yes: "Yes, delete", onConfirm: () => { acted += 1; } }, "Delete"));
is("first it is only the button, and nothing was done", [first.includes(">Delete</button>"), first.includes("Yes, delete"), acted], [true, false, 0]);
const source = readFileSync("components/confirm-action.tsx", "utf8");
is("the second press is the only one that acts, and the safe choice takes focus", [/onClick=\{\(\) => setAsking\(true\)\}/.test(source), /await onConfirm\(\)/.test(source), /autoFocus onClick=\{\(\) => setAsking\(false\)\}/.test(source)], [true, true, true]);

part("The four that did not ask, now ask");
for (const [file, question] of [
  ["components/blog-editor.tsx", "Delete this post?"],
  ["components/agreements-studio.tsx", "Delete this agreement?"],
  ["components/licence-key-editor.tsx", "Remove the keys not yet given?"],
  ["components/webhook-editor.tsx", "Remove this endpoint?"],
] as const) {
  const text = readFileSync(file, "utf8");
  is(`${file}: through ConfirmAction, saying what happens`, text.includes("<ConfirmAction") && text.includes(question), true);
}
const studio = readFileSync("app/studio/page.tsx", "utf8");
is("disconnecting Stripe asks first, without scripts too", /<details[^>]*data-confirm-disconnect="stripe"[\s\S]{0,400}Disconnect Stripe\? Your store stops taking payments[\s\S]{0,200}Yes, disconnect/.test(studio), true);
is("stopping PayPal asks first, without scripts too", /<details[^>]*data-confirm-disconnect="paypal"[\s\S]{0,400}Stop selling with PayPal\?[\s\S]{0,200}Yes, stop/.test(studio), true);
is("the blog's delete no longer acts on its first press", /onClick=\{\(\) => void remove\(\)\}/.test(readFileSync("components/blog-editor.tsx", "utf8")), false);
done();
