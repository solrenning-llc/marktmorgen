/**
 * 624 [SZ8](35): every new application approved at once, when the creator
 * chose it (lib/affiliate-setting.ts autoApprove, lib/affiliates.ts
 * openAffiliateLink). Off by default and for programs saved before; on, a
 * new applicant is approved through the same decision as by hand; someone
 * the creator declined stays out; the studio says what it does.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { claimHandle, ensureStatsId, setAffiliateSetting, storeForEmail } from "@/lib/store";
import { NO_AFFILIATES, parseAffiliateSetting } from "@/lib/affiliate-setting";
import { decide, openAffiliateLink } from "@/lib/affiliates";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const linkKey = (token: string) => `nl:aff:link:${sha(`nimbus-aff-link:${token}`).slice(0, 40)}`;

async function main(): Promise<void> {
  redis.clear();
  part("The setting");
  is("off by default and for programs saved before", [NO_AFFILIATES.autoApprove ?? false, parseAffiliateSetting({ enabled: true }).autoApprove ?? false], [false, false]);
  is("on only with an explicit yes", [parseAffiliateSetting({ autoApprove: true }).autoApprove, parseAffiliateSetting({ autoApprove: "yes" }).autoApprove ?? false], [true, false]);

  const owner = "auto@example.com";
  await claimHandle(owner, "autoshop", "Auto Shop", "");
  const statsId = (await ensureStatsId(owner))!.statsId!;
  const open = async (email: string, token: string) => {
    await redis.pipeline([["SET", linkKey(token), JSON.stringify({ s: statsId, e: email, n: "" }), "EX", 600]]);
    const result = await openAffiliateLink((await storeForEmail(owner))!, token);
    return result.ok ? result.affiliate.status : result.reason;
  };
  const openId = async (email: string, token: string) => {
    await redis.pipeline([["SET", linkKey(token), JSON.stringify({ s: statsId, e: email, n: "" }), "EX", 600]]);
    const result = await openAffiliateLink((await storeForEmail(owner))!, token);
    return result.ok ? result.affiliate.id : "";
  };

  part("Off: each application waits");
  await setAffiliateSetting(owner, { ...NO_AFFILIATES, enabled: true, rates: {} });
  is("a new applicant is pending", await open("first@example.com", "a".repeat(64)), "pending");

  part("On: approved at once, through the same decision");
  await setAffiliateSetting(owner, { ...NO_AFFILIATES, enabled: true, rates: {}, autoApprove: true });
  is("a new applicant is approved", await open("second@example.com", "b".repeat(64)), "approved");
  is("someone already waiting is not changed by opening their link again", await open("first@example.com", "c".repeat(64)), "pending");

  part("On: someone declined or removed, under another spelling of the same inbox, waits for the creator");
  await setAffiliateSetting(owner, { ...NO_AFFILIATES, enabled: true, rates: {} });
  const bob = await openId("bob@gmail.com", "d".repeat(64));
  const carol = await openId("carol@gmail.com", "e".repeat(64));
  const shop = async () => (await storeForEmail(owner))!;
  await decide(await shop(), bob, "decline");
  await decide(await shop(), carol, "approve");
  await decide(await shop(), carol, "remove");
  await setAffiliateSetting(owner, { ...NO_AFFILIATES, enabled: true, rates: {}, autoApprove: true });
  is("declined bob@gmail.com: b.o.b@gmail.com stays pending", await open("b.o.b@gmail.com", "f".repeat(64)), "pending");
  is("declined bob@gmail.com: bob+2@gmail.com stays pending", await open("bob+2@gmail.com", "1".repeat(64)), "pending");
  is("removed carol@gmail.com: Carol+promo@Gmail.com stays pending", await open("Carol+promo@Gmail.com", "2".repeat(64)), "pending");
  is("removed carol@gmail.com: c.arol@googlemail.com stays pending", await open("c.arol@googlemail.com", "3".repeat(64)), "pending");
  is("an unrelated new address is still approved at once", await open("dave@gmail.com", "4".repeat(64)), "approved");

  part("The studio");
  const studio = readFileSync("components/affiliate-studio.tsx", "utf8");
  is("a labeled switch that says what it does and that declined people stay out", studio.includes("Approve every application at once") && studio.includes("Anyone you declined or removed stays out: an application from an address already in your program, even written another way, waits for you. Off, each application waits for you."), true);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
