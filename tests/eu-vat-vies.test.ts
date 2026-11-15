/**
 * EU VAT under art. 9a, unit 1 (IVA, 14/11/2026): the VIES check of a business buyer's number, made once at the sale
 * and kept whole. The answers below are the official test service's own (POST
 * https://ec.europa.eu/taxation_customs/vies/rest-api/check-vat-test-service, 14/11/2026, HTTP 200 for each), with only
 * requestDate fixed; no real number is checked and nothing reaches the network. Synthetic only.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { VIES_CHECK_URL, VIES_FRESH_SECONDS, checkVies, readViesAnswer, splitVatNumber, viesValidFor } from "@/lib/eu-vat-vies";

const at = new Date("2026-11-14T12:00:00.000Z");
const official = {
  valid: { countryCode: "DE", vatNumber: "100", requestDate: "2026-11-14T11:59:59.000Z", valid: true, requestIdentifier: "", name: "John Doe", address: "123 Main St, Anytown, UK" },
  notValid: { countryCode: "DE", vatNumber: "200", requestDate: "2026-11-14T11:59:59.000Z", valid: false, requestIdentifier: "", name: "---", address: "---" },
  error: (code: string) => ({ actionSucceed: false, errorWrappers: [{ error: code }] }),
};

test("a typed number splits into its Member State and body; Greece is EL, never GR; anything else is no number", () => {
  assert.deepEqual(splitVatNumber("DE 123.456-789"), { country: "DE", number: "123456789" });
  assert.deepEqual(splitVatNumber("el123456789"), { country: "GR", number: "123456789" });
  assert.deepEqual(splitVatNumber("ATU12345678"), { country: "AT", number: "U12345678" });
  for (const raw of ["GR123456789", "US123456789", "GB123456789", "XI123456789", "DE1", "DE12345678<script>", "", null, 123, "DE".padEnd(41, "1")]) {
    assert.equal(splitVatNumber(raw), null, String(raw));
  }
});

test("only VIES's own valid: true for the number asked is valid; not valid is invalid; name and address '---' are kept as unknown", () => {
  const valid = readViesAnswer({ country: "DE", number: "100" }, 200, official.valid, at);
  assert.deepEqual(valid, {
    state: "valid", country: "DE", number: "100", askedAt: "2026-11-14T12:00:00.000Z", viesDate: "2026-11-14T11:59:59.000Z", error: null,
    name: "John Doe", address: "123 Main St, Anytown, UK", requestIdentifier: null,
  });
  const notValid = readViesAnswer({ country: "DE", number: "200" }, 200, official.notValid, at);
  assert.equal(notValid.state, "invalid");
  assert.equal(notValid.name, null);
  assert.equal(notValid.address, null);
});

test("an answer about another number or country, a non-200 status or a body without valid is never valid", () => {
  assert.equal(readViesAnswer({ country: "DE", number: "101" }, 200, official.valid, at).state, "unavailable");
  assert.equal(readViesAnswer({ country: "FR", number: "100" }, 200, official.valid, at).state, "unavailable");
  assert.equal(readViesAnswer({ country: "DE", number: "100" }, 500, official.valid, at).state, "unavailable");
  assert.equal(readViesAnswer({ country: "DE", number: "100" }, 200, { ...official.valid, valid: "true" }, at).state, "unavailable");
  assert.equal(readViesAnswer({ country: "DE", number: "100" }, 200, [official.valid], at).state, "unavailable");
  assert.equal(readViesAnswer({ country: "DE", number: "100" }, 200, null, at).state, "unavailable");
  // Greece answers under its prefix EL.
  assert.equal(readViesAnswer({ country: "GR", number: "100" }, 200, { ...official.valid, countryCode: "EL" }, at).state, "valid");
});

test("MS_UNAVAILABLE and every other 'try again' answer is unavailable, with its code kept; a refused number is invalid", () => {
  for (const code of ["MS_UNAVAILABLE", "SERVICE_UNAVAILABLE", "TIMEOUT", "GLOBAL_MAX_CONCURRENT_REQ", "GLOBAL_MAX_CONCURRENT_REQ_TIME", "MS_MAX_CONCURRENT_REQ", "MS_MAX_CONCURRENT_REQ_TIME", "IP_BLOCKED", "INVALID_REQUESTER_INFO", "SOMETHING_NEW"]) {
    const answer = readViesAnswer({ country: "DE", number: "301" }, 200, official.error(code), at);
    assert.equal(answer.state, "unavailable", code);
    assert.equal(answer.error, code);
  }
  for (const code of ["INVALID_INPUT", "VAT_BLOCKED"]) assert.equal(readViesAnswer({ country: "DE", number: "201" }, 200, official.error(code), at).state, "invalid", code);
  assert.equal(readViesAnswer({ country: "DE", number: "201" }, 200, official.error("not a code <b>"), at).error, null);
});

test("checkVies asks once, by POST, with the country prefix and the body; never throws", async () => {
  const calls: { url: string; body: string }[] = [];
  const reply = (status: number, value: unknown) => async (url: string, init: { body: string }) => {
    calls.push({ url, body: init.body });
    return { status, text: async () => (typeof value === "string" ? value : JSON.stringify(value)) };
  };
  const valid = await checkVies("DE100", { fetcher: reply(200, official.valid), now: () => at });
  assert.equal(valid?.state, "valid");
  assert.deepEqual(calls, [{ url: VIES_CHECK_URL, body: JSON.stringify({ countryCode: "DE", vatNumber: "100" }) }]);
  calls.length = 0;
  await checkVies("EL100", { fetcher: reply(200, { ...official.valid, countryCode: "EL" }), now: () => at });
  assert.equal(JSON.parse(calls[0].body).countryCode, "EL", "Greece is asked as EL");
  assert.equal((await checkVies("DE301", { fetcher: reply(200, official.error("MS_UNAVAILABLE")), now: () => at }))?.state, "unavailable");
  assert.equal((await checkVies("DE100", { fetcher: reply(200, "<html>busy</html>"), now: () => at }))?.state, "unavailable");
  assert.equal((await checkVies("DE100", { fetcher: reply(200, "x".repeat(20_000)), now: () => at }))?.state, "unavailable");
  const thrown = await checkVies("DE100", { fetcher: async () => { throw new Error("socket hang up"); }, now: () => at });
  assert.equal(thrown?.state, "unavailable");
  const aborted = await checkVies("DE100", { fetcher: async () => { throw Object.assign(new Error("timeout"), { name: "TimeoutError" }); }, now: () => at });
  assert.equal(aborted?.state, "unavailable");
  // Not a number: no request at all.
  calls.length = 0;
  assert.equal(await checkVies("US123", { fetcher: reply(200, official.valid), now: () => at }), null);
  assert.equal(calls.length, 0);
});

test("a valid answer counts only for its country, the same day, at most VIES_FRESH_SECONDS old and never from the future", () => {
  const valid = readViesAnswer({ country: "DE", number: "100" }, 200, official.valid, at);
  assert.equal(viesValidFor(valid, "DE", at), true);
  assert.equal(viesValidFor(valid, "DE", new Date(at.getTime() + VIES_FRESH_SECONDS * 1000)), true);
  assert.equal(viesValidFor(valid, "DE", new Date(at.getTime() + VIES_FRESH_SECONDS * 1000 + 1000)), false);
  assert.equal(viesValidFor(valid, "DE", new Date(at.getTime() - 1000)), false);
  assert.equal(viesValidFor(valid, "FR", at), false);
  const lateNight = readViesAnswer({ country: "DE", number: "100" }, 200, official.valid, new Date("2026-11-14T23:59:00.000Z"));
  assert.equal(viesValidFor(lateNight, "DE", new Date("2026-11-15T00:01:00.000Z")), false, "VIES confirms only the current day");
  assert.equal(viesValidFor(readViesAnswer({ country: "DE", number: "200" }, 200, official.notValid, at), "DE", at), false);
  assert.equal(viesValidFor({ ...valid, askedAt: "yesterday" }, "DE", at), false);
  assert.equal(viesValidFor("valid", "DE", at), false);
});
