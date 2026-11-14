/**
 * WCAG 2.4.8 (location) on the site's pages one level down: /help/zoom sits
 * under the help center and /developers/checkout-script under Developers. Each
 * shows a trail (components/breadcrumb.tsx): the level above as a link, then
 * the page itself marked as the current page. The real pages are rendered.
 */
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import ZoomHelp from "@/app/help/zoom/page";
import CheckoutScript from "@/app/developers/checkout-script/page";

async function html(page: unknown): Promise<string> {
  const element = typeof page === "function" ? await (page as () => unknown)() : page;
  return renderToStaticMarkup(element as React.ReactElement);
}

async function main() {
  for (const [name, page, up, here] of [
    ["Zoom help", ZoomHelp, { href: "/help", label: "Help center" }, "Zoom for Marktmorgen"],
    ["Checkout script", CheckoutScript, { href: "/developers", label: "Developers" }, "Checkout script"],
  ] as const) {
    const markup = await html(page);
    const trail = markup.match(/<nav aria-label="Breadcrumb"[^>]*>([\s\S]*?)<\/nav>/);
    assert.ok(trail, `${name}: the page shows where it is (a trail)`);
    assert.match(trail[1], new RegExp(`<a[^>]*href="${up.href}"[^>]*>${up.label}</a>`), `${name}: the level above, ${up.label}, is a link`);
    assert.match(trail[1], new RegExp(`aria-current="page"[^>]*>${here}<`), `${name}: the page itself, ${here}, is marked as the current page`);
  }
  console.log("Subpage trails: Zoom help and Checkout script each show where they are");
}

void main().catch((error) => { console.error(error); process.exit(1); });
