/**
 * 655 [WG15], unit 2: the studio's tax setting leads to the page that reads where the creator's Stripe
 * account collects tax (app/studio/tax/page.tsx, PR #2735), which had no link from the studio. Shown only
 * once the Stripe account is connected (before that there is nothing to read), as a plain link whose words
 * say where it goes (WCAG 2.4.9), in the same tab.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { TaxEditor } from "@/components/tax-editor";
import { done, is, part } from "./check";

const render = (connected: boolean, status: "active" | "pending" | "unknown") =>
  renderToStaticMarkup(createElement(TaxEditor, { tax: { enabled: false, included: false }, status, connected } as Parameters<typeof TaxEditor>[0]));
const link = (html: string) => html.match(/<a[^>]*href="\/studio\/tax"[^>]*>([\s\S]*?)<\/a>/);

part("Connected: one link to the page of tax registrations, whatever Stripe said");
for (const status of ["active", "pending", "unknown"] as const) {
  const found = link(render(true, status));
  is(`${status}: linked, in the same tab, its words naming where it goes`, [Boolean(found), Boolean(found && !/target=/.test(found[0])), /where you are registered to collect tax/i.test(found?.[1] ?? "")], [true, true, true]);
}

part("Not connected: no link (nothing to read yet)");
is("no link", Boolean(link(render(false, "unknown"))), false);

done();
