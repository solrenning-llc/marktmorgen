/**
 * CA232: protect the existing full-dashboard, Stripe fee/loss collection setup.
 * Exercises actual account creation with fetch intercepted; never creates an account.
 * This is configuration evidence, not a guarantee against all platform losses.
 */
import assert from "node:assert/strict";
import { COUNTRIES, createConnectedAccount } from "@/lib/stripe-connect";
import { done, is, part } from "./check";

process.env.STRIPE_SECRET_KEY = "sk_test_configuration_regression_only";
delete process.env.STRIPE_CONNECT_API_BASE;

type Call = { url: string; method: string; headers: Headers; body: Record<string, unknown> };
const calls: Call[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input);
  assert.equal(url, "https://api.stripe.com/v2/core/accounts");
  assert.equal(init?.method, "POST");
  calls.push({ url, method: init?.method ?? "", headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) });
  return Response.json({ id: "acct_fixture004" });
}) as typeof fetch;

async function main(): Promise<void> {
  part("Only the countries Stripe confirmed for a US platform are offered (Stripe support, 28 October 2026)");
  is("42 countries are offered", COUNTRIES.length, 42);
  is("Malaysia is not offered: direct charges are not available there for a US platform", COUNTRIES.some((c) => c.code === "my"), false);
  is("Brazil is not offered: direct charges there are a public beta", COUNTRIES.some((c) => c.code === "br"), false);
  is("India is not offered: Stripe India accounts are by invitation only", COUNTRIES.some((c) => c.code === "in"), false);
  is("every offered country appears once", new Set(COUNTRIES.map((c) => c.code)).size, COUNTRIES.length);

  part("Every offered country keeps the creator's full Stripe dashboard and Stripe responsibilities");
  for (const country of COUNTRIES) {
    const before = calls.length;
    const id = await createConnectedAccount({ email: "creator@example.com", country: country.code, displayName: "Synthetic creator", idempotencyKey: `connect-synthetic-${country.code}` });
    is(country.code + ": exactly one intercepted request", calls.length - before, 1);
    is(country.code + ": return the account Stripe confirmed", id, "acct_fixture004");
    const call = calls.at(-1)!;
    is(country.code + ": full dashboard and Stripe fee/loss collection", call.body, {
      contact_email: "creator@example.com",
      display_name: "Synthetic creator",
      dashboard: "full",
      identity: { country: country.code },
      configuration: { merchant: { capabilities: { card_payments: { requested: true } } } },
      defaults: { responsibilities: { fees_collector: "stripe", losses_collector: "stripe" } },
    });
    is(country.code + ": pinned creation API and synthetic credential", [
      call.headers.get("Stripe-Version"), call.headers.get("Authorization"), call.headers.get("Content-Type"),
    ], ["2026-08-26.dahlia", "Bearer sk_test_configuration_regression_only", "application/json"]);
    is(country.code + ": account creation is on the platform, without impersonating a connected account", call.headers.get("Stripe-Account"), null);
    // Codex L-20261120-0258: the attempt's idempotency key goes with it, so a request made again gets the same account.
    is(country.code + ": asked with the attempt's idempotency key", call.headers.get("Idempotency-Key"), `connect-synthetic-${country.code}`);
  }
  part("Unapproved countries never reach even the synthetic provider");
  for (const country of ["br", "", "unknown"]) {
    const before = calls.length;
    await assert.rejects(createConnectedAccount({ email: "creator@example.com", country, displayName: "Synthetic creator", idempotencyKey: "connect-synthetic-refused" }), /country is needed/);
    is(country + ": no account request", calls.length, before);
  }
  done();
}
void main();
