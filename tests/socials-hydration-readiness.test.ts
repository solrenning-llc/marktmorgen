import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import { SocialsEditor } from "@/components/socials-editor";
import { done, is, part } from "./check";

const router = {
  bfcacheId: "socials-hydration-fixture",
  back() {},
  forward() {},
  refresh() {},
  push() {},
  replace() {},
  prefetch() {},
};

const draw = (saved: Parameters<typeof SocialsEditor>[0]["socials"]) =>
  renderToStaticMarkup(
    createElement(
      AppRouterContext.Provider,
      { value: router },
      createElement(SocialsEditor, { socials: saved }),
    ),
  );

part("The creator profile panel is honest before hydration");
for (const [label, saved] of [
  ["Add your profiles", []],
  ["Edit your profiles", [{ network: "instagram", url: "https://www.instagram.com/harbor" }]],
] as const) {
  const html = draw([...saved]);
  const button = html.match(/<button\b[^>]*>[\s\S]*?<\/button>/)?.[0] ?? "";
  is(`${label} keeps one server-rendered control`, button.length > 0, true);
  is(`${label} says its handler is not ready`, button.includes('aria-disabled="true"'), true);
  is(`${label} gives voice control the visible Loading name`, button.includes("aria-label="), false);
  is(`${label} visibly says Loading before hydration`, />Loading…<\//.test(button), true);
  is(`${label} does not draw a false open editor`, html.includes("data-socials-editor"), false);
}
done();
