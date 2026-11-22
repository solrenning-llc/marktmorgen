/**
 * LOW of the review at d3dc5296a3 on #4248: readDomain (domainStatus, domainCheckup) took "proved" from any store's
 * proof, so after the owner proved a domain, the store that had only claimed it was told it was "set up to show your
 * store" (VR 2). A domain is live for a store only when the proof on its key is that store's own, under its address or
 * one it still owns. Synthetic: Vercel and the key are stand-ins.
 */
import { domainCheckup, domainKey, domainStatus } from "@/lib/domains";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.VERCEL_API_TOKEN = "test-token";
process.env.VERCEL_PROJECT_ID = "prj_status_own";

globalThis.fetch = (async (input: RequestInfo | URL) => {
  const url = String(input);
  const body = url.includes("/config") ? { misconfigured: false, recommendedIPv4: [{ rank: 1, value: ["76.76.21.21"] }] } : { verified: true, apexName: "famous-status.com" };
  return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
}) as typeof fetch;

const NAME = "famous-status.com";
const owner = { sid: "sstatusowner000000000000000000001", handle: "realowner", previousHandles: ["oldowner"] };
const squatter = { sid: "sstatussquat000000000000000000001", handle: "squatter", previousHandles: [] as string[] };

async function main(): Promise<void> {
  redis.clear();
  part("The owner's proof makes it live for the owner only");
  redis.run(["SET", domainKey(NAME), "realowner"]);
  is("live for the owner", (await domainStatus(NAME, owner))?.live, true);
  is("not live for the store that only claimed it", (await domainStatus(NAME, squatter))?.live, false);
  const checked = await domainCheckup(NAME, squatter);
  is("nor in its checkup", checked !== null && checked !== "gone" && checked.live, false);
  part("A proof under an address the store still owns is its own");
  redis.run(["SET", domainKey(NAME), "oldowner"]);
  is("live for the owner after a rename", (await domainStatus(NAME, owner))?.live, true);
  part("An unproved claim is live for nobody");
  redis.run(["SET", domainKey(NAME), "?squatter"]);
  is("not live for its claimer", (await domainStatus(NAME, squatter))?.live, false);
  done();
}
void main();
