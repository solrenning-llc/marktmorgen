/**
 * #5256 audit (coordinators ea4f 3 and 729c 16): the sentence beside the affiliate spreadsheet's button says what the
 * download takes in the plan's state, tied to the button (aria-describedby), and a teammate of a store whose plan has
 * ended, who can no longer download it, does not see the button nor a sentence that is false for them (VR 2).
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import { AffiliateStudio } from "@/components/affiliate-studio";
import { parseAffiliateSetting } from "@/lib/affiliate-setting";
import { BOOK_EXPORT_ENDED_NOTE, BOOK_EXPORT_NOTE } from "@/lib/affiliate-book-export-rules";

function render(exportNote?: string | null): string {
  return renderToStaticMarkup(createElement(AppRouterContext.Provider, { value: {} as never },
    createElement(AffiliateStudio, {
      handle: "example", setting: parseAffiliateSetting({ enabled: true }), products: [],
      rows: [], lines: [], payouts: [], refundsChecked: true, today: "2026-11-23",
      ...(exportNote === undefined ? {} : { exportNote }),
    })));
}

test("while a plan runs: the button, and the sentence it is described by", () => {
  const html = render(BOOK_EXPORT_NOTE);
  assert.match(html, /Download everything \(CSV\)/);
  assert.match(html, /aria-describedby="affiliate-export-note"/);
  assert.match(html, /id="affiliate-export-note"[^>]*>The file is counted from your studio(&#x27;|')s requests by its size\.</);
});

test("by default, the running plan's sentence", () => {
  assert.match(render(), /The file is counted from your studio(&#x27;|')s requests by its size\./);
});

test("once the plan has ended, for its owner: the downloads it keeps", () => {
  const html = render(BOOK_EXPORT_ENDED_NOTE);
  assert.match(html, /Download everything \(CSV\)/);
  assert.match(html, /Since your plan ended, you can download this file twice in all\./);
  assert.doesNotMatch(html, /counted from your studio/);
});

test("once the plan has ended, for a teammate: no button and no sentence", () => {
  const html = render(null);
  assert.doesNotMatch(html, /Download everything/);
  assert.doesNotMatch(html, /affiliate-export-note/);
});
