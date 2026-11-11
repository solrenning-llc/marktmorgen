/**
 * Claude 3 (cloud A), CX-123 rules 24 and 30 (lib/affiliates.ts
 * recordFromLink and the buyer's join from an order): an address is claimed
 * for a new affiliate id (HSETNX on the emails hash) before the record itself
 * is written. When anything fails between the two (a dropped connection on
 * the code's claim or on the record's HSET, or a crooked HSETNX reply read
 * as "lost"), the address stays pointing at an id that has no record, and
 * every later attempt for that address loses the HSETNX, reads that id, finds
 * no record and is refused as "expired": the person can never join.
 *
 * Here: one dropped connection while the record is being made (the code's claim), then the same person opening a
 * fresh link. They must get in (pending), with one record and the address
 * pointing at it; a double press still makes only one record.
 */
import { createHash } from "node:crypto";
import { claimHandle, ensureStatsId, setAffiliateSetting, storeForEmail } from "@/lib/store";
import { NO_AFFILIATES } from "@/lib/affiliate-setting";
import { openAffiliateLink } from "@/lib/affiliates";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

globalThis.fetch = (async () => new Response(JSON.stringify({ id: "email_1" }))) as typeof fetch;

type Command = (string | number)[];
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const linkKey = (token: string) => `nl:aff:link:${sha(`nimbus-aff-link:${token}`).slice(0, 40)}`;

const real = redis.pipeline.bind(redis);
let failCodeClaim = 0;
let codesKey = "";
let crookClaim = 0;
let peopleKey = "";
let emailsKey = "";
redis.pipeline = (async (batch: Command[]) => {
  if (failCodeClaim > 0 && batch.some((c) => c[0] === "HSETNX" && c[1] === codesKey)) {
    failCodeClaim -= 1;
    throw new Error("connection dropped");
  }
  const values = await real(batch);
  if (crookClaim > 0 && batch.some((c) => c[0] === "HSETNX" && c[1] === emailsKey)) {
    crookClaim -= 1;
    return values.map((v, i) => (batch[i][0] === "HSETNX" && batch[i][1] === emailsKey ? "1" : v));
  }
  return values;
}) as typeof redis.pipeline;

async function main(): Promise<void> {
  redis.clear();
  process.env.RESEND_API_KEY = "re_test_dangling_stand_in";
  const owner = "dangling@example.com";
  await claimHandle(owner, "danglingshop", "Dangling Shop", "");
  const statsId = (await ensureStatsId(owner))!.statsId!;
  peopleKey = `nl:aff:${statsId}:people`;
  emailsKey = `nl:aff:${statsId}:emails`;
  codesKey = `nl:aff:${statsId}:codes`;
  await setAffiliateSetting(owner, { ...NO_AFFILIATES, enabled: true, rates: {} });
  let n = 0;
  const open = async (email: string) => {
    const token = String(++n).padStart(64, "0");
    await real([["SET", linkKey(token), JSON.stringify({ s: statsId, e: email, n: "" }), "EX", 600]]);
    try {
      const result = await openAffiliateLink((await storeForEmail(owner))!, token);
      return result.ok ? result.affiliate.status : result.reason;
    } catch (error) {
      return `threw ${(error as Error).message}`;
    }
  };
  const records = async () => {
    const flat = (await real([["HGETALL", peopleKey]]))[0] as string[];
    return flat.filter((_, i) => i % 2 === 1).map((raw) => (JSON.parse(raw) as { email: string }).email);
  };
  const pointsAtRecord = async (email: string) => {
    const [id] = await real([["HGET", emailsKey, email]]);
    if (typeof id !== "string") return false;
    const [rec] = await real([["HGET", peopleKey, id]]);
    return typeof rec === "string";
  };

  part("Control");
  is("a new applicant is pending", await open("ana@example.com"), "pending");
  is("one record", await records(), ["ana@example.com"]);

  part("The connection drops once while the new affiliate is made: the address is not lost for good");
  failCodeClaim = 1;
  is("the failed open reports a failure", (await open("ben@example.com")).startsWith("threw"), true);
  is("the same person opening a fresh link gets in", await open("ben@example.com"), "pending");
  is("their address points at their record", await pointsAtRecord("ben@example.com"), true);
  is("one record each", (await records()).sort(), ["ana@example.com", "ben@example.com"]);

  part("A crooked claim reply: never a person locked out");
  crookClaim = 1;
  const first = await open("cy@example.com");
  is("the open is refused or unknown, never a record without its address", first === "pending" || first.startsWith("threw") || first === "expired", true);
  is("the same person opening again gets in", await open("cy@example.com"), "pending");
  is("their address points at their record", await pointsAtRecord("cy@example.com"), true);

  part("A double press still makes one record");
  const [a, b] = await Promise.all([open("dee@example.com"), open("dee@example.com")]);
  is("both answered pending", [a, b], ["pending", "pending"]);
  is("one record for that address", (await records()).filter((e) => e === "dee@example.com").length, 1);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
