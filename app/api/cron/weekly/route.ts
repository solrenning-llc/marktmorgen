import type { NextRequest } from "next/server";
import { cronAllowed } from "@/lib/request-guard";
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { NIMBUS_FROM, isSenderConfigured, sendEmail } from "@/lib/email";
import { visitedFolders } from "@/lib/traffic";
import { monthKey } from "@/lib/delivery";
import { storeOf } from "@/lib/usage-billing";
import { standingOf } from "@/lib/plan-standing";
import { SITE_URL } from "@/lib/site-url";
import { EMAIL_KEY_HOLDS_MS, claimWeek, readNumbers, releaseWeek, sendPart, tryPeriodAgain, weekPeriod, weeklyMessage, weeklyOff, weeklyToken } from "@/lib/stats-report";
import { weeklySummary } from "@/lib/numbers-ask";
import { aiAvailableFor } from "@/lib/ai";
import { readSpends } from "@/lib/ad-spend";
import { recordSample } from "@/lib/benchmarks";
import { weeklyMemberToken, weeklyTeam } from "@/lib/stats-report";
import { readTeamMembers } from "@/lib/team";
import { can } from "@/lib/team-roles";
import { UNKNOWN_SALES_GOAL_CENTS, readSalesGoal, withGoalAvailability } from "@/lib/sales-goal";
import { chatAddress, forChat, postToChat } from "@/lib/chat-summary";
import type { Store } from "@/lib/store";
import type { StatsData } from "@/lib/stats";
import type { AdSpend } from "@/lib/ad-spend-rules";

/**
 * The weekly email to each creator whose store had visitors (lib/stats-report.ts).
 *
 * Runs every hour on Mondays and Tuesdays and sends to at most MAX_PER_RUN
 * stores a run, so a growing number of stores is worked through over the day
 * without a run outliving its time; each store is claimed for the week before
 * anything is read, so nobody gets two. Only stores with a plan running —
 * paid or in its trial — are written to: what the email costs is then a
 * fraction of a cent inside a plan that pays for it.
 *
 * A store whose creator pressed "Stop" is not emailed, and a store that had no
 * visitors in the week is not written to at all. Where the creator chose a
 * Slack or Discord channel (lib/chat-summary.ts), the same summary is posted
 * there too — and still is after "Stop", which stops emails, not the channel
 * the creator set up apart.
 *
 * Everything the summary is written from (the numbers, the ad spend, who
 * gets the team copies) is read before anything goes: a read that fails is
 * not "none" (rule 24), so nothing is sent on it and the week is let go for a
 * later run. The post and the owner's email are each marked once for the week
 * (lib/stats-report.ts, sendPart); one that did not go lets the week go, so a
 * later run sends what is missing and nothing twice, at most SUMMARY_TRIES
 * runs for the week. One that may have gone is never sent again (rule 24): the
 * owner's email is tried again only while its key still holds (EMAIL_KEY_HOLDS_MS).
 * The team copies go with the owner's email, never before.
 */
export const maxDuration = 60;
const MAX_PER_RUN = 25;
const TIME_BUDGET_MS = 45_000;

export async function GET(request: NextRequest) {
  if (!(await cronAllowed(request))) {
    return new Response("Unauthorized", { status: 401, headers: { "Cache-Control": "no-store" } });
  }
  if (!isRedisConfigured() || !isSenderConfigured()) {
    return Response.json({ ok: false, error: "unavailable" }, { status: 503 });
  }
  const [got] = await redisPipeline([["SET", "nl:weekly:lock", "1", "NX", "EX", 120]]);
  if (got === null) return Response.json({ ok: true, busy: true });

  const started = Date.now();
  const out = { looked: 0, sent: 0, quiet: 0, stopped: 0, unpaid: 0, failed: 0, unconfirmed: 0 };
  try {
    const now = new Date();
    const lastMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 15));
    const folders = [...new Set([...(await visitedFolders(monthKey(now))), ...(await visitedFolders(monthKey(lastMonth)))])];
    for (const folder of folders) {
      if (out.looked >= MAX_PER_RUN || Date.now() - started > TIME_BUDGET_MS) break;
      const store = await storeOf(folder).catch(() => null);
      if (!store) continue;
      const standing = standingOf(store);
      if (standing !== "paid" && standing !== "trial") {
        out.unpaid += 1;
        continue;
      }
      const emailOff = await weeklyOff(store.handle);
      // An address that could not be read is not "no channel" (rule 24): nothing is claimed, so a later run sends the email and the post together.
      const chat = await chatAddress(store.statsId).catch(() => undefined);
      if (chat === undefined) {
        out.failed += 1;
        continue;
      }
      if (emailOff && !chat) {
        out.stopped += 1;
        continue;
      }
      const at = Date.now();
      if (!(await claimWeek(store.handle, at))) continue;
      out.looked += 1;
      const period = weekPeriod(store.handle, at);
      const read = await summaryInputs(store, emailOff).catch((error) => {
        console.error("weekly: a read the summary is written from failed", error);
        return null;
      });
      if (!read) {
        // Not read this time, so not a quiet week, and no ad spend or team read as none: the week is let go and a later run tries again, as the monthly email does.
        await releaseWeek(store.handle, at).catch((error) => console.error("weekly: letting the week go failed", error));
        out.failed += 1;
        continue;
      }
      const { data, spends, copies } = read;
      // Its rates, for the ranges stores its size are set beside (lib/benchmarks.ts): read here anyway.
      await recordSample(store, data);
      const token = weeklyToken(store.handle);
      const stopUrl = `${SITE_URL}/api/store/weekly?h=${encodeURIComponent(store.handle)}&t=${encodeURIComponent(token)}`;
      const goal = (await readSalesGoal(store.statsId, store.currency).catch(() => ({ cents: UNKNOWN_SALES_GOAL_CENTS }))).cents;
      const message = withGoalAvailability(token ? weeklyMessage(store, data, stopUrl, spends, goal) : null, goal);
      if (!message) {
        out.quiet += 1;
        continue;
      }
      // A few sentences written from the same numbers, first, where the creator turned it on (lib/numbers-ask.ts).
      if (store.weeklyAi && aiAvailableFor(store)) {
        const lead = await weeklySummary(store, data).catch(() => null);
        if (lead) message.text = `In short: ${lead}\n\n${message.text}`;
      }
      let missed = false;
      let unconfirmed = false;
      if (chat) {
        const post = await sendPart(period, "posted", () => postToChat(chat, `${message.subject}\n\n${forChat(message.text)}`));
        if (post === "missed") missed = true;
        if (post === "unconfirmed") unconfirmed = true;
      }
      if (!emailOff) {
        const owner = await sendPart(period, "emailed", () => sendEmail({ meter: { by: "company" },
          from: NIMBUS_FROM,
          to: store.email,
          subject: message.subject,
          text: message.text,
          headers: { "List-Unsubscribe": `<${stopUrl}>` },
          // One key for the period, so a try that the sender could not confirm is not sent again by a later try.
          idempotencyKey: `numbers-summary:${period.key}`,
        }), { keyHoldsMs: EMAIL_KEY_HOLDS_MS });
        if (owner === "missed") missed = true;
        if (owner === "unconfirmed") unconfirmed = true;
        if (owner === "sent") {
          out.sent += 1;
          // The same email to the team members the owner chose, while they are on
          // the team in a role that sees the numbers, each with their own stop link:
          // only with the owner's own, so a week tried again never sends them twice.
          for (const email of copies) {
            const own = `${SITE_URL}/api/store/weekly?h=${encodeURIComponent(store.handle)}&e=${encodeURIComponent(email)}&t=${encodeURIComponent(weeklyMemberToken(store.handle, email))}`;
            const text = message.text.replace(stopUrl, own).replace("You get this every Monday while your store has visitors.", `You get this because the owner of @${store.handle} added you.`);
            await sendEmail({ meter: { by: "company" }, from: NIMBUS_FROM, to: email, subject: message.subject, text, headers: { "List-Unsubscribe": `<${own}>` } }).catch(() => false);
          }
        }
      }
      if (missed) {
        // What did not go is sent by a later run, a bounded number of times; what went, or may have gone, is not sent again.
        out.failed += 1;
        await tryPeriodAgain(period);
      } else if (unconfirmed) {
        // Only what may have gone is left, and it is never sent blind: the week stays claimed, and no run reads it again.
        out.unconfirmed += 1;
      } else if (emailOff) out.stopped += 1;
    }
    console.log(`weekly: ${JSON.stringify(out)}`);
    return Response.json({ ok: true, ...out }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("weekly emails failed", error);
    return Response.json({ ok: false, error: "failed", ...out }, { status: 500 });
  } finally {
    await redisPipeline([["DEL", "nl:weekly:lock"]]).catch(() => undefined);
  }
}

/**
 * What the week's summary is written from, read exactly: the numbers (null when they could not be read), the ad
 * spend, and the team members the owner chose who are on the team in a role that sees the numbers. Throws when
 * the spend or the team could not be read, so neither is ever taken as none (rule 24).
 */
async function summaryInputs(store: Store, emailOff: boolean): Promise<{ data: StatsData; spends: AdSpend[]; copies: string[] } | null> {
  const data = await readNumbers(store);
  if (!data) return null;
  const spends = await readSpends(store.statsId);
  if (emailOff) return { data, spends, copies: [] };
  const chosen = await weeklyTeam(store.handle);
  if (!chosen.length || !store.sid) return { data, spends, copies: [] };
  const members = await readTeamMembers(store.sid);
  const copies = chosen.filter((email) => {
    const member = members.find((m) => m.email.toLowerCase() === email);
    return Boolean(member && can(member.role, "stats"));
  });
  return { data, spends, copies };
}
