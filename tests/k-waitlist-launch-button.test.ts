/**
 * Review of #3801 (LEVE, VR and AX274 3.3.6): launching a waitlist needs "send", so the studio does not
 * offer an Editor the button that would take them through the two presses and only then be refused.
 * The owner and an Admin (who have "send") still see it. Claude 3 (cloud K), 11 November 2026.
 */
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { WaitlistPanel } from "@/components/waitlist-panel";
import { done, is } from "./check";

const view = { soon: true, confirmed: 2, waiting: 0, launch: null };
const panel = (extra: Record<string, unknown>) =>
  renderToStaticMarkup(createElement(WaitlistPanel, { productId: "p1", initial: view, suggestedAddress: "", price: "$39", ...extra } as never));

const launchButton = /<button[^>]*>Put it on sale/;
is("with sending: the launch button is offered", launchButton.test(panel({})), true);
const editor = panel({ canLaunch: false });
is("without sending (an Editor): no launch button", launchButton.test(editor), false);
is("nor the note and address that only a launch uses", /<textarea|street-address/.test(editor), false);
is("and it says who can do it", editor.includes("the owner or an Admin"), true);
const page = readFileSync("app/studio/page.tsx", "utf8");
is("the studio passes the role's \"send\" to the product editor", /canSend=\{may\("send"\)\}/.test(page), true);
const editorSource = readFileSync("components/product-editor.tsx", "utf8");
is("and the product editor hands it to the waitlist panel", /canLaunch=\{canSend\}/.test(editorSource), true);
done();
