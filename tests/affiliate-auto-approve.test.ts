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
import { canonicalEmail, decide, holdFlags, listAffiliates, openAffiliateLink, readAffiliate, requestAffiliateLink, setPayAddress } from "@/lib/affiliates";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

// A stand-in for the email service: what the creator is told is read from here.
const mails: { to: string; text: string }[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  if (url.hostname === "api.resend.com") {
    const body = JSON.parse(String(init?.body)) as { to: string | string[]; text: string };
    mails.push({ to: [body.to].flat()[0], text: body.text });
    return new Response(JSON.stringify({ id: `email_${mails.length}` }));
  }
  return new Response("{}", { status: 404 });
}) as typeof fetch;

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const linkKey = (token: string) => `nl:aff:link:${sha(`nimbus-aff-link:${token}`).slice(0, 40)}`;

async function main(): Promise<void> {
  redis.clear();
  process.env.RESEND_API_KEY = "re_test_auto_approve_stand_in";
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
  // Built from parts, so no personal-looking address is written in this file (scripts/check_public_data.py).
  const GMAIL = "gmail" + ".com";
  const GOOGLEMAIL = "googlemail" + ".com";
  const bob = await openId("bob@" + GMAIL, "d".repeat(64));
  const carol = await openId("carol@" + GMAIL, "e".repeat(64));
  const shop = async () => (await storeForEmail(owner))!;
  await decide(await shop(), bob, "decline");
  await decide(await shop(), carol, "approve");
  await decide(await shop(), carol, "remove");
  await setAffiliateSetting(owner, { ...NO_AFFILIATES, enabled: true, rates: {}, autoApprove: true });
  is("declined bob at a Gmail address: the same with dots stays pending", await open("b.o.b@" + GMAIL, "f".repeat(64)), "pending");
  is("declined bob at a Gmail address: the same with a + tag stays pending", await open("bob+2@" + GMAIL, "1".repeat(64)), "pending");
  is("removed carol at a Gmail address: a + tag in other case stays pending", await open("Carol+promo@" + GMAIL.replace("g", "G"), "2".repeat(64)), "pending");
  is("removed carol at a Gmail address: dots at googlemail stay pending", await open("c.arol@" + GOOGLEMAIL, "3".repeat(64)), "pending");
  is("an unrelated new address is still approved at once", await open("dave@" + GMAIL, "4".repeat(64)), "approved");

  part("The creator is told why one waited, truly in every case");
  const toldAbout = (address: string) => mails.filter((m) => m.to === owner && m.text.includes(address)).at(-1)?.text ?? "";
  is("the email about a waiting match names declined and removed people, written the same or another way",
    toldAbout("b.o.b@" + GMAIL).includes("the address matches one already on your list (including people you declined or removed), written the same way or another way, so it waits for your decision."), true);
  is("an approved one does not say it waited", toldAbout("dave@" + GMAIL).includes("It was not approved at once"), false);

  part("A trailing dot on the domain is the same domain");
  is("canonical form", canonicalEmail("Bob+x@" + GMAIL + "."), "bob@" + GMAIL);
  is("a declined inbox with a trailing dot waits", await open("bob@" + GMAIL + ".", "5".repeat(64)), "pending");

  part("A payout address set to a declined or removed person's inbox is held");
  const daveId = (await listAffiliates((await storeForEmail(owner))!)).find((a) => a.email === "dave@" + GMAIL)!.id;
  const dave = (await readAffiliate((await storeForEmail(owner))!, daveId))!;
  const flagsOf = async (id: string) => {
    const shop = (await storeForEmail(owner))!;
    return holdFlags(shop, await listAffiliates(shop), new Map()).get(id) ?? [];
  };
  // Two people turned away with no other record of their inbox: only the declined or removed record can match.
  const erin = await openId("erin@example.com", "6".repeat(64));
  const finn = await openId("finn@example.com", "7".repeat(64));
  await decide((await storeForEmail(owner))!, erin, "decline");
  await decide((await storeForEmail(owner))!, finn, "remove");
  is("dave is not held to start with", await flagsOf(daveId), []);
  is("dave sets his payout to declined erin's inbox, written another way", await setPayAddress((await storeForEmail(owner))!, dave, "Erin+pay@example.com"), { ok: true });
  is("and his commission is held for the same address", await flagsOf(daveId), ["same-address"]);
  await setPayAddress((await storeForEmail(owner))!, (await readAffiliate((await storeForEmail(owner))!, daveId))!, "finn@example.com");
  is("the same with removed finn's inbox", await flagsOf(daveId), ["same-address"]);

  part("The creator is the creator however the address is written");
  is("a + tag on the store's own address is refused as the owner", await requestAffiliateLink({ store: (await storeForEmail(owner))!, email: "auto+me@example.com", note: "", ip: "203.0.113.9", origin: "https://marktmorgen.com" }), "owner");

  part("The studio");
  const studio = readFileSync("components/affiliate-studio.tsx", "utf8");
  is("a labeled switch that says what it does, no more than the code keeps", studio.includes("Approve every application at once") && studio.includes("Someone you declined or removed stays out with the same address, and an application whose address matches one on your list written another way we recognize (a + tag, or dots in a Gmail address) waits for your decision. Off, each application waits for you.") && !studio.includes("Anyone you declined or removed stays out"), true);
  is("the hold says declined and removed people count too", studio.includes("Another affiliate in your program, or someone you declined or removed, has the same inbox or payout address"), true);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
