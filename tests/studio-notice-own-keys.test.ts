// The studio's ?gsc= and ?assistant= notices are typed by whoever writes the
// link. A name every object inherits (constructor, toString, __proto__,
// hasOwnProperty) is not one of the notices: the page must show none, never an
// empty status line with a function inside it (found reviewing #2936).
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import { GoogleSearches } from "@/components/google-searches";
import { StoreAssistantEditor } from "@/components/store-assistant-editor";
import { NO_ASSISTANT } from "@/lib/store-assistant-rules";
import { NO_NEXT_OFFER } from "@/lib/next-offer-rules";
import { NO_ASSIST_REMINDER } from "@/lib/assistant-reminder-rules";

const INHERITED = ["constructor", "toString", "__proto__", "hasOwnProperty"];

function quietly<T>(run: () => T): { out: T; warned: string[] } {
  const warned: string[] = [];
  const was = console.error;
  console.error = (...args: unknown[]) =>
    void warned.push(args.map(String).join(" "));
  try {
    return { out: run(), warned };
  } finally {
    console.error = was;
  }
}

const searches = (result: string) =>
  quietly(() =>
    renderToStaticMarkup(
      createElement(GoogleSearches, {
        searches: null,
        operator: { connected: false, account: "" },
        result,
      }),
    ),
  );

const assistant = (notice: string) =>
  quietly(() =>
    renderToStaticMarkup(
      createElement(
        AppRouterContext.Provider,
        { value: {} as never },
        createElement(StoreAssistantEditor, {
          setting: NO_ASSISTANT,
          next: NO_NEXT_OFFER,
          remind: NO_ASSIST_REMINDER,
          postal: true,
          plan: null,
          onSale: false,
          canBill: false,
          refusal: null,
          usage: null,
          missed: [],
          notice,
          pin: "",
        }),
      ),
    ),
  );

test("?gsc= with a known result shows its notice (control)", () => {
  const { out, warned } = searches("declined");
  assert.match(
    out,
    /role="status"[^>]*>Google&#x27;s page was closed without allowing access\. Nothing changed\.<\/p>/,
  );
  assert.deepEqual(warned, []);
});

for (const name of INHERITED) {
  test(`?gsc=${name} shows the card with no notice`, () => {
    const { out, warned } = searches(name);
    assert.equal(out, searches("").out);
    assert.doesNotMatch(out, /role="status"/);
    assert.deepEqual(warned, []);
  });
}

test("?assistant= with a known notice shows it (control)", () => {
  const { out, warned } = assistant("stopping");
  assert.match(
    out,
    /role="status"[^>]*>It stops at the end of the month already paid\. Nothing more is charged\.<\/p>/,
  );
  assert.deepEqual(warned, []);
});

for (const name of INHERITED) {
  test(`?assistant=${name} shows the editor with no notice`, () => {
    const { out, warned } = assistant(name);
    assert.equal(out, assistant("").out);
    assert.doesNotMatch(out, /role="status"/);
    assert.deepEqual(warned, []);
  });
}
