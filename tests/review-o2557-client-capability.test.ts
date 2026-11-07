import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const SESSION = "cs_review_secret_123";

test("React Flight serializes every field passed to a client component", () => {
  const program = `
    const React = require("react");
    const r = require("next/dist/compiled/react-server-dom-webpack/server.node");
    const Client = r.registerClientReference(function () {}, "client.js", "default");
    (async () => {
      const stream = r.renderToReadableStream(
        React.createElement(Client, { event: { id: "ev_safe", order: "${SESSION}" } }),
        {},
      );
      process.stdout.write(await new Response(stream).text());
    })();
  `;
  const run = spawnSync(process.execPath, ["--conditions", "react-server", "-e", program], {
    cwd: process.cwd(),
    encoding: "utf8",
  });
  assert.match(run.stdout, /ev_safe/);
  assert.match(run.stdout, new RegExp(SESSION));
});

test("the thanks page never crosses an order capability into StorePixels", () => {
  const page = readFileSync("app/[handle]/thanks/page.tsx", "utf8");
  const pixels = readFileSync("components/store-pixels.tsx", "utf8");
  assert.doesNotMatch(page, /event=\{\{[\s\S]{0,220}\border:\s*sessionId\b/);
  assert.doesNotMatch(pixels, /\border\?:\s*string/);
});
