/** Five synthetic HTTP-mapping cases. Not authentication or SDK security verification. */
import assert from "node:assert/strict";
import type { NextRequest } from "next/server";
import { POST } from "@/app/api/store/file/route";
import { admission, type Refusal } from "./q-store-api-e-h-upload-world";
import { resetWorld, state, FOLDER } from "./upload-route-world";
import { reset, calls } from "./upload-budget-redis";

let networkAttempts = 0;
globalThis.fetch = async () => { networkAttempts++; throw new Error("External network is forbidden in this synthetic proof"); };
const errors: string[] = [];
console.error = (...values: unknown[]) => { errors.push(values.map(value => value instanceof Error ? value.message : String(value)).join(" ").slice(0, 500)); };

async function main() {
  const scenarios: [Refusal, number][] = [["signed_out", 401], ["forbidden", 403], ["gone", 403], ["used", 429], ["two_step", 403]];
  assert.equal(scenarios.length, 5);
  const results = [];
  for (const [reason, expectedStatus] of scenarios) {
    reset(); resetWorld();
    admission.reason = reason; admission.calls = 0; admission.needs.length = 0;
    const request = new Request("https://upload.example.test/api/store/file", {
      method: "POST", headers: { "Content-Type": "application/json", Origin: "https://upload.example.test" },
      // The canonical upload-route-world SDK seam takes this body and invokes
      // the actual route's getSignedToken callback. No SDK protocol claim.
      body: JSON.stringify({ pathname: `stores/${FOLDER}/product-1/file.pdf`, clientPayload: JSON.stringify({ productId: "product-1" }) }),
    }) as NextRequest;
    const response = await POST(request);
    const body = await response.json() as { ok?: unknown; error?: unknown };
    const commands = calls.reduce((total, batch) => total + batch.length, 0);
    assert.deepEqual(admission.needs, ["products"], `${reason}: real route checks products exactly once`);
    assert.equal(admission.calls, 1);
    assert.equal(body.ok, false, `${reason}: never success`);
    assert.equal(commands, 0, `${reason}: no Redis command or budget reservation`);
    assert.ok(commands <= 2000);
    assert.deepEqual(state.events, [], `${reason}: no provider, storage measurement or token issuance`);
    assert.equal(networkAttempts, 0, `${reason}: no external fetch`);
    results.push({ reason, expectedStatus, status: response.status, error: body.error, commands, admissionCalls: admission.calls, providerEvents: state.events.length, pass: response.status === expectedStatus && body.error !== "server_error" });
  }
  const failures = results.filter(result => !result.pass).length;
  console.log(JSON.stringify({ scope: "Legacy upload route HTTP refusal mapping only", source: "5c07315505e1d53ee6401021601cd688fa98ecda", scenarios: results, passed: results.length - failures, failures, networkAttempts, errors, limits: { scenarios: 5, commandsPerScenario: 2000, timeoutMs: 120000, combinedLogBytes: 262144 }, limitation: "Real studio authentication and real SDK are replaced by existing canonical test seams. Blob upload issuance remains unreachable through the unchanged production gate; no positive upload is claimed." }, null, 2));
  process.exitCode = failures ? 1 : 0;
}
void main().catch(error => { console.log(JSON.stringify({ harnessFailure: String(error) })); process.exitCode = 2; });
