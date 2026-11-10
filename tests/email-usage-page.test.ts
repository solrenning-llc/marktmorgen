import test from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import Page from "@/app/studio/email/page";
import { world, reset } from "./email-usage-page-world";

const render = async () => renderToStaticMarkup(await Page({ searchParams: Promise.resolve({}) }));

test("the real server page preserves the existing exact count and reads it only once", async () => {
  for (const count of [0, 2_345, 12_345]) {
    reset(); world.used = count;
    const html = await render();
    assert.ok(html.includes(`${count.toLocaleString("en-US")} of 10,000 this month.`));
    assert.equal(world.reads, 1);
    assert.deepEqual(world.args, ["synthetic-list", "synthetic-period"]);
    assert.match(html, /data-month-known="true"/);
    assert.ok(html.indexOf('id="email-usage-title"') < html.indexOf('id="synthetic-composer"'));
  }
});

test("the real page keeps draft work available when the count is unknown", async () => {
  for (const value of [null, "0", -1, 0.5, NaN, Infinity]) {
    reset(); world.used = value;
    const html = await render();
    assert.match(html, /Your email use could not be loaded/);
    assert.match(html, /Draft editor preserved/);
    assert.match(html, /data-used="unknown"/);
    assert.match(html, /data-month-known="false"/);
    assert.doesNotMatch(html, /0 of 10,000|aria-valuenow|progressbar/);
    assert.equal(world.reads, 1);
  }
  reset(); world.throws = true;
  assert.match(await render(), /data-month-known="false"/);
  assert.equal(world.reads, 1);
});

test("missing count prerequisites are unknown without adding a counter read", async () => {
  for (const absent of ["window", "redis", "list"] as const) {
    reset();
    if (absent === "redis") world.redis = false;
    else world[absent] = null;
    const html = await render();
    assert.match(html, /could not be loaded/);
    assert.match(html, /Draft editor preserved/);
    assert.match(html, /data-month-known="false"/);
    assert.doesNotMatch(html, /0 of 10,000|aria-valuenow/);
    assert.equal(world.reads, 0);
  }
});
