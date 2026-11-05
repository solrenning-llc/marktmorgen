import assert from "node:assert/strict";
import { test } from "node:test";
import { renderedContentDeclarations } from "./e2e/skip-content-focus.mjs";

for (const development of [false, true]) test(`all route and shared main declarations render a native focus target (${development ? "development" : "production"})`, async () => {
  const mains = await renderedContentDeclarations(process.cwd(), development);
  const missing = mains.filter(main => !/\btabindex="-1"/.test(main.html.match(/<main\b[^>]*>/)![0])).map(main => main.route);
  assert.deepEqual(missing, [], "every real main#content declaration must emit tabindex=-1 before any hydration");
});

