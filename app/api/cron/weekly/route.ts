import type { NextRequest } from "next/server";
import { cronAllowed } from "@/lib/request-guard";
import { isRedisConfigured } from "@/lib/redis";
import { claimMark, claimValue, releaseMark } from "@/lib/claim-mark";
import { NIMBUS_FROM, isSenderConfigured, sendEmail } from "@/lib/email";
import { visitedFolders } from "@/lib/traffic";
import { monthKey } from "@/lib/delivery";
import { storeOf } from "@/lib/usage-billing";
import { standingOf } from "@/lib/plan-standing";
import { SITE_URL } from "@/lib/site-url";
import { claimWeek, readNumbers, releaseWeek, weeklyMessage, weeklyOff, weeklyToken } from "@/lib/stats-report";
import { weeklySummary } from "@/lib/numbers-ask";
import { aiAvailableFor } from "@/lib/ai";
import { readSpends } from "@/lib/ad-spend";
import { recordSample } from "@/lib/benchmarks";
import { weeklyMemberToken, weeklyTeam } from "@/lib/stats-report";
import { readTeam } from "@/lib/team";
import { can } from "@/lib/team-roles";
import { UNKNOWN_SALES_GOAL_CENTS, readSalesGoal, withGoalAvailability } from "@/lib/sales-goal";
import { chatAddress, forChat, postToChat } from "@/lib/chat-summary";

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
  // One run at a time, on an exact claim (lib/claim-mark.ts, CX-123 rule 24): held by another run is busy; an
  // unknown answer runs nothing this time, and the lock is let go at the end only while it still holds this run's
  // own value, so a run never deletes another run's lock.
  const lock = claimValue();
  const got = await claimMark("nl:weekly:lock", 120, lock);
  if (got === "taken") return Response.json({ ok: true, busy: true });
  if (got !== "ours") return Response.json({ ok: false, error: "lock_unknown" }, { status: 503 });

  const started = Date.now();
  const out = { looked: 0, sent: 0, quiet: 0, stopped: 0, unpaid: 0, failed: 0 };
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
      // The week is read once, so the claim and its release name the same week even across Monday's midnight.
      const at = Date.now();
      if (!(await claimWeek(store.handle, at))) continue;
      out.looked += 1;
      const data = await readNumbers(store).catch(() => null);
      if (!data) {
        // Not read this time, so not a quiet week: the week is let go and counted failed, so a later run that week
        // tries again, as the monthly email does.
        await releaseWeek(store.handle, at).catch((error) => console.error("weekly: letting the week go failed", error));
        out.failed += 1;
        continue;
      }
      // Its rates, for the ranges stores its size are set beside (lib/benchmarks.ts): read here anyway.
      await recordSample(store, data);
      const token = weeklyToken(store.handle);
      const stopUrl = `${SITE_URL}/api/store/weekly?h=${encodeURIComponent(store.handle)}&t=${encodeURIComponent(token)}`;
      const spends = await readSpends(store.statsId).catch(() => []);
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
      if (chat) await postToChat(chat, `${message.subject}\n\n${forChat(message.text)}`).catch(() => false);
      if (emailOff) {
        out.stopped += 1;
        continue;
      }
      const ok = await sendEmail({ meter: { by: "company" },
        from: NIMBUS_FROM,
        to: store.email,
        subject: message.subject,
        text: message.text,
        headers: { "List-Unsubscribe": `<${stopUrl}>` },
      }).catch(() => false);
      if (ok) out.sent += 1;
      else out.failed += 1;
      // The same email to the team members the owner chose, while they are on
      // the team in a role that sees the numbers, each with their own stop link.
      const chosen = await weeklyTeam(store.handle).catch(() => []);
      if (chosen.length && store.sid) {
        const team = await readTeam(store.sid).catch(() => null);
        for (const email of chosen) {
          const member = team?.members.find((m) => m.email.toLowerCase() === email);
          if (!member || !can(member.role, "stats")) continue;
          const own = `${SITE_URL}/api/store/weekly?h=${encodeURIComponent(store.handle)}&e=${encodeURIComponent(email)}&t=${encodeURIComponent(weeklyMemberToken(store.handle, email))}`;
          const text = message.text.replace(stopUrl, own).replace("You get this every Monday while your store has visitors.", `You get this because the owner of @${store.handle} added you.`);
          await sendEmail({ meter: { by: "company" }, from: NIMBUS_FROM, to: email, subject: message.subject, text, headers: { "List-Unsubscribe": `<${own}>` } }).catch(() => false);
        }
      }
    }
    console.log(`weekly: ${JSON.stringify(out)}`);
    return Response.json({ ok: true, ...out }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("weekly emails failed", error);
    return Response.json({ ok: false, error: "failed", ...out }, { status: 500 });
  } finally {
    await releaseMark("nl:weekly:lock", lock);
  }
}
