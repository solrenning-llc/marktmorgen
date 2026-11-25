/**
 * "What the AI proposes" (/studio/agent) is reached from the studio (board #5285, row #1856: Claude 5's MÉDIO, a
 * CHANGES on the merged head). The MCP tool and the developer guide send creators there, but no studio screen linked
 * to it, and the help center said "there is no link to it in your studio yet". The studio's API keys card, where the
 * keys an AI assistant uses are made, now links to it by name, and the help answer says where the link is.
 *
 * Rendered, not read from the source: the real card through react-dom/server; synthetic data only.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ApiKeyEditor } from "@/components/api-key-editor";
import type { ShownKey } from "@/lib/api-key-rules";
import { HELP_SECTIONS } from "@/lib/help-content";
import { done, is, part } from "./check";

async function main(): Promise<void> {
  part("The API keys card links to the proposals page");
  const variants: (ShownKey[] | "unread")[] = [[], "unread"];
  for (const keys of variants) {
    const html = renderToStaticMarkup(createElement(ApiKeyEditor, { keys }));
    const link = /<a[^>]*href="\/studio\/agent"[^>]*>([^<]*)<\/a>/.exec(html);
    is(`${keys === "unread" ? "keys unread" : "no keys yet"}: a link to /studio/agent`, link !== null, true);
    is("its text names the page (WCAG 2.4.9)", link?.[1].trim(), "What the AI proposes");
  }

  part("The help answer says where the link is");
  const answers = HELP_SECTIONS.flatMap((section) => section.items).filter((item) => item.q === "How do I approve changes my AI assistant prepared?");
  is("the answer is found once", answers.length, 1);
  const text = answers.flatMap((item) => item.a).join(" ");
  is("it no longer says there is no link", text.includes("there is no link to it in your studio yet"), false);
  is("it says the link is on the API keys card", text.includes("API keys card"), true);
  done();
}

main().catch((error) => {
  console.log("✗ crashed:", error);
  process.exit(1);
});
