/**
 * #5285 row #4248 (Codex V's LOW on the merged head 5d5beeb996, still in main 86bd73f989): txtRecords
 * (lib/domain-proof.ts) read any DNS failure, a timeout or a server failure as well as "no such record", as an empty
 * list. So when another store held only an unproved claim on a domain, a passing DNS failure while the real owner
 * checked made proveDomain answer "taken", as if the owner's record were not there. Now only "no such name" or "no
 * record of that type" (ENOTFOUND, ENODATA) is an empty list; any other failure is unknown, and the check answers
 * "waiting", so the creator checks again. Synthetic only: resolveTxt is a stand-in; nothing real is asked.
 */
import dns from "node:dns/promises";
import { domainKey } from "@/lib/domains";
import { proveDomain } from "@/lib/domain-proof";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const owner = { sid: "s5285dnsowner00000000000000000001", handle: "realowner", previousHandles: [] as string[] };

/** The DNS: fails with the code given, or answers no record at all. */
let failWith = "";
(dns as { resolveTxt: (host: string) => Promise<string[][]> }).resolveTxt = async () => {
  if (failWith) throw Object.assign(new Error(`queryTxt ${failWith}`), { code: failWith });
  return [];
};

let n = 0;
const domain = () => `famous${(n += 1)}.dnsunknown5285.com`;

async function main(): Promise<void> {
  redis.clear();
  console.error = () => {};

  for (const code of ["ESERVFAIL", "ETIMEOUT", "ECONNREFUSED", "EREFUSED"]) {
    part(`Another store's unproved claim, and the DNS fails (${code})`);
    const name = domain();
    redis.run(["SET", domainKey(name), "?squatter", "EX", 3600]);
    failWith = code;
    is(`RED: ${code} is not read as "no record": the owner is told to wait, not that it is taken`, await proveDomain(owner, name), "waiting");
    is("and the claim is left as it was", redis.run(["GET", domainKey(name)]), "?squatter");
  }

  for (const code of ["ENOTFOUND", "ENODATA"]) {
    part(`Another store's unproved claim, and the DNS says there is no record (${code})`);
    const name = domain();
    redis.run(["SET", domainKey(name), "?squatter", "EX", 3600]);
    failWith = code;
    is(`${code} is no record: the domain is taken`, await proveDomain(owner, name), "taken");
  }
  done();
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
