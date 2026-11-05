import assert from "node:assert/strict";
import test from "node:test";

import { waitForReactChangeHandler } from "./e2e/react-hydration.mjs";

test("the observer binds the exact locator handle and waits for its React change handler", async () => {
  const element: Record<string, unknown> = { "__reactProps$one": { value: "server" } };
  const other = { "__reactProps$other": { onChange() {} } };
  let handleReads = 0;
  let observations = 0;
  const control = {
    async elementHandle() {
      handleReads += 1;
      return element;
    },
  };
  const page = {
    async waitForFunction(predicate: (node: Record<string, unknown>) => boolean, handle: Record<string, unknown>) {
      assert.equal(handle, element);
      assert.equal(predicate(other), true, "control: another hydrated element has a handler");
      observations += 1;
      assert.equal(predicate(handle), false, "the exact field is not hydrated yet");
      element["__reactProps$one"] = { onChange() {} };
      observations += 1;
      assert.equal(predicate(handle), true, "the exact field becomes editable");
    },
  };

  await waitForReactChangeHandler(page as never, control as never);
  assert.equal(handleReads, 1);
  assert.equal(observations, 2);
});

test("a locator without an attached field fails before observing the page", async () => {
  let observed = false;
  const page = { async waitForFunction() { observed = true; } };
  const control = { async elementHandle() { return null; } };

  await assert.rejects(
    waitForReactChangeHandler(page as never, control as never),
    /controlled field is not attached/i,
  );
  assert.equal(observed, false);
});
