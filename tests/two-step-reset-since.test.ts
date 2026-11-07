/**
 * Claude 1's focal on #2896 (LOW, rule 30): the moment two-step login was turned on (`since`) is the floor of the
 * turn-off day's check, so it is read only in the shape this code writes once a day is set. Before, a `since`
 * missing, text, null or negative read as 0 (or below), and a turn-off day this code never writes (8 days after
 * 1970) passed: the record was deleted and the emailed link alone opened a full session. finishSetup always writes
 * `since: now`, so no real record changes. Synthetic records only.
 */
import { createHash } from "node:crypto";
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { NextRequest } from "next/server";
import { finishProvenSignIn } from "@/lib/signin-finish";
import { store as redis } from "./redis-stub";

process.env.NIMBUS_DATA_KEY ??= "tests-only-not-a-real-deployment-secret";
globalThis.fetch = (async () => new Response("{}", { status: 404 })) as typeof fetch;

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const recordKey = (email: string) => `nl:2fa:${sha(`nimbus-2fa:${email}`).slice(0, 40)}`;
const codeHash = (code: string) => sha(`nimbus-2fa-code:${code.toLowerCase().replace(/[^a-z0-9]/g, "")}`);
const WHO = "since-reset@example.com";
const DAY = 86_400_000;
const record = (fields: Record<string, unknown>) => JSON.stringify({ s: "synthetic-sealed-secret", codes: [codeHash("abcd-efgh")], last: -1, backup: "", ...fields });
const signIn = () => finishProvenSignIn(new NextRequest("https://marktmorgen.com/api/auth/callback", { method: "POST" }), WHO, "link", "/studio");
const put = (value: string) => redis.pipeline([["SET", recordKey(WHO), value]]);

for (const [label, fields] of [
  ["since missing, the day 8 days after 1970", { reset: 8 * DAY }],
  ["since as text, the day 8 days after 1970", { since: "1", reset: 8 * DAY }],
  ["since null, the day 8 days after 1970", { since: null, reset: 8 * DAY }],
  ["since far below zero, the day 100 ms after 1970", { since: -1e15, reset: 100 }],
  ["since zero, the day 8 days after 1970", { since: 0, reset: 8 * DAY }],
  ["since a fraction, the day 8 days after 1970", { since: 0.5, reset: 8 * DAY }],
] as [string, Record<string, unknown>][]) {
  test(`a link login opens no session when ${label}`, async () => {
    redis.clear();
    await put(record(fields));
    const response = await signIn();
    assert.ok(!(response.headers.get("set-cookie") ?? "").includes("nl_session="), "no session cookie");
    assert.equal(response.headers.get("location"), "https://marktmorgen.com/signin?status=login-unknown");
    assert.equal((await redis.pipeline([["EXISTS", recordKey(WHO)]]))[0], 1, "two-step login is still on");
  });
}

for (const [label, fields] of [
  ["a day in 6 days, turned on a day ago", { since: Date.now() - DAY, reset: Date.now() + 6 * DAY }],
  ["no day asked and since missing (an older record)", { reset: 0 }],
] as [string, Record<string, unknown>][]) {
  test(`control: ${label} waits for the code`, async () => {
    redis.clear();
    await put(record(fields));
    const response = await signIn();
    assert.equal(response.headers.get("location"), "https://marktmorgen.com/signin/code");
  });
}
