// Behavioral regression from Codex X5, X5-20261118-1149-fix-pr-3498-check-in-next-code.md.
// Real component, synthetic hooks and deferred replies; no browser, provider or account.
import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";

test("a check-in response keeps the next ticket already typed in the field", async () => {
  const state = [];
  let hook = 0;
  let focused = false;
  globalThis.checkInHooks = {
    useState(initial) {
      const i = hook++;
      if (!(i in state)) state[i] = initial;
      return [state[i], (value) => {
        state[i] = typeof value === "function" ? value(state[i]) : value;
      }];
    },
    useRef(initial) {
      const i = hook++;
      return state[i] ??= { current: initial };
    },
  };
  const { outputFiles } = await build({
    entryPoints: ["components/ticket-check-in.tsx"],
    bundle: true,
    format: "esm",
    jsx: "automatic",
    define: { "process.env.NODE_ENV": '"production"' },
    write: false,
    plugins: [{
      name: "check-in-hooks",
      setup(builder) {
        builder.onResolve({ filter: /^react$/ }, ({ path }) => ({
          path, namespace: "fixture-hooks",
        }));
        builder.onLoad({ filter: /.*/, namespace: "fixture-hooks" }, () => ({
          contents: "export const { useState, useRef } = globalThis.checkInHooks;",
        }));
      },
    }],
  });
  const { TicketCheckIn } = await import(
    "data:text/javascript;base64," + Buffer.from(outputFiles[0].text).toString("base64")
  );
  function show() {
    hook = 0;
    const [form] = TicketCheckIn({ event: "test-event" }).props.children;
    const field = form.props.children.find((child) => child?.type === "input").props;
    field.ref.current = { focus() { focused = true; } };
    return { field, submit: () => form.props.onSubmit({ preventDefault() {} }) };
  }
  function type(value) { show().field.onChange({ target: { value } }); }
  const originalFetch = globalThis.fetch;
  const firstReply = Promise.withResolvers();
  const secondReply = Promise.withResolvers();
  const sent = [];
  globalThis.fetch = async (path, init) => {
    assert.equal(path, "/api/store/check-in");
    sent.push(JSON.parse(init.body));
    return sent.length === 1 ? firstReply.promise : secondReply.promise;
  };
  try {
    type("ticket-one");
    show().submit();
    type("ticket-two");
    show().submit();
    assert.deepEqual(sent.map(({ code }) => code), ["ticket-one"]);
    firstReply.resolve(Response.json({ ok: true, outcome: "admitted" }));
    await new Promise(setImmediate);
    assert.equal(show().field.value, "ticket-two", "the first reply must preserve the next code");
    assert.equal(focused, true);
    show().submit();
    assert.deepEqual(sent.map(({ code }) => code), ["ticket-one", "ticket-two"]);
    assert.notEqual(sent[0].attempt, sent[1].attempt);
    secondReply.resolve(Response.json({ ok: true, outcome: "admitted" }));
    await new Promise(setImmediate);
    assert.equal(show().field.value, "");
  } finally {
    globalThis.fetch = originalFetch;
    delete globalThis.checkInHooks;
  }
});
