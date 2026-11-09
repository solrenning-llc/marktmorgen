/**
 * The "Made with Marktmorgen" link at the foot of a store page carries the
 * creator's invite code (14 [D11], the owner's complement of 8 November
 * 2026), and only under its locks:
 *
 *   1. while the invite programme is paused, or sales are closed, the link
 *      is the plain one it has always been, and no code is read for it;
 *   2. with both open and a valid code, the link is the invite page with
 *      that code and nothing else (no email, name or internal id);
 *   3. a code that is not a valid one is never put in it;
 *   4. opening the store writes nothing in the visitor's browser for it: the
 *      invite cookie is born only on the invite page (app/invite/[code]/accept);
 *   5. the link is never prefetched, so a visit sends no extra request;
 *   6. a store whose plan lets it take the badge off, and that did, shows
 *      nothing at all.
 *
 * The code is read without ever being made (existingInviteCode): a store page
 * must not write. Synthetic stores only, against the in-memory Redis.
 */
import { readFileSync } from "node:fs";
import { BADGE_HOME, INVITE_BADGE_LINK_ON, badgeHref, badgeInviteCode } from "@/lib/badge-link";
import { existingInviteCode, inviteCode, myCodeKey } from "@/lib/creator-invites";
import { INVITE_PROGRAM_OPEN } from "@/lib/creator-invite-rules";
import { PLANS_ON_SALE } from "@/lib/opening";
import { COMMANDS } from "./traffic-cost";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const SID = "0123456789abcdef0123456789abcdef";
const OTHER = "fedcba9876543210fedcba9876543210";

/** Every command sent to the database, counted as the pipeline is called. */
let sent = 0;
const pipeline = redis.pipeline.bind(redis);
redis.pipeline = (commands: (string | number)[][]) => {
  sent += commands.length;
  return pipeline(commands);
};

async function main(): Promise<void> {
  redis.clear();

  part("1. Programme paused or sales closed: the plain link, and no code read for it");
  is("the switch is both locks together, and both are off today", INVITE_BADGE_LINK_ON, INVITE_PROGRAM_OPEN && PLANS_ON_SALE);
  is("off today", INVITE_BADGE_LINK_ON, false);
  is("off: the plain link even with a valid code", badgeHref("abcdefgh", false), BADGE_HOME);
  is("the plain link is the home page", BADGE_HOME, "/");
  const code = await inviteCode(SID);
  is("a synthetic store has a code", typeof code === "string", true);
  const before = sent;
  is("off: no code is read for the link", await badgeInviteCode(SID, false), null);
  is("off: not one command sent", sent - before, 0);

  part("2. Both open and a valid code: the invite page with that code and nothing else");
  is("on: the invite page with the code", badgeHref("abcdefgh", true), "/invite/abcdefgh");
  is("on: the store's own code, read back", await badgeInviteCode(SID, true), code);
  const href = badgeHref(code, true);
  is("only the code is in it: no query, no fragment", /^\/invite\/[a-hj-km-np-z2-9]{8}$/.test(href), true);

  part("3. A code that is not a valid one is never put in it");
  for (const bad of ["", "ABCDEFGH", "abcdefg", "abcdefghi", "abcdefg1", "a@b.co12", "../admin", "abcdefgi", null]) {
    is(`on: ${JSON.stringify(bad)} gives the plain link`, badgeHref(bad as string | null, true), BADGE_HOME);
  }
  redis.run(["SET", myCodeKey(OTHER), "not-a-code"]);
  is("on: a stored value that is not a code is not used", await badgeInviteCode(OTHER, true), null);
  is("on: a store with no code yet gets none, and none is made", await existingInviteCode("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"), null);
  is("and nothing was written for it", redis.run(["GET", myCodeKey("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")]), null);
  is("a store id of another shape reads nothing", await existingInviteCode("not-a-sid"), null);

  part("4. Opening the store writes nothing in the visitor's browser for it");
  const page = readFileSync("app/[handle]/page.tsx", "utf8");
  const badge = page.slice(page.indexOf("Our name at the foot of the page"), page.indexOf("<StoreTracking"));
  is("the badge's part of the page sets no cookie and stores nothing", /cookies\(\)|document\.cookie|localStorage|sessionStorage|\.set\(/.test(badge), false);
  is("the code is only read, never made, on the page", /\binviteCode\(/.test(page), false);
  is("the page reads the code through the locked helper", /badgeInviteCode\(store\.sid\)/.test(page), true);

  part("5. The link is never prefetched");
  is("the badge's link says prefetch={false}", /<Link href=\{badgeLink\} prefetch=\{false\}/.test(badge), true);

  part("6. A store that may take the badge off and did shows nothing");
  is("the badge is shown only when kept on or when the plan does not allow it off", /store\.look\.badge \|\| !canUse\(store, "branding"\) \?/.test(badge), true);
  is("and the code is read only when the badge is shown", /const showBadge = store\.look\.badge \|\| !canUse\(store, "branding"\);/.test(page) && /showBadge \? await badgeInviteCode\(store\.sid\) : null/.test(page), true);

  part("Cost: one command more on the front page only while the link is on");
  is("the front page's commands", COMMANDS.frontPage, 4 + (INVITE_BADGE_LINK_ON ? 1 : 0));

  done();
}

main();
