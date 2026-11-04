import type { NextRequest } from "next/server";
import { cronAllowed } from "@/lib/request-guard";
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { NIMBUS_FROM, isSenderConfigured, sendEmail } from "@/lib/email";
import { visitedFolders } from "@/lib/traffic";
import { monthKey } from "@/lib/delivery";
import { storeOf } from "@/lib/usage-billing";
import { standingOf } from "@/lib/plan-standing";
import { SITE_URL } from "@/lib/site-url";
import { claimWeek, readNumbers, weeklyMessage, weeklyOff, weeklyToken } from "@/lib/stats-report";
import { weeklySummary } from "@/lib/numbers-ask";
import { aiAvailableFor } from "@/lib/ai";
import { readSpends } from "@/lib/ad-spend";
import { recordSample } from "@/lib/benchmarks";
import { weeklyMemberToken, weeklyTeam } from "@/lib/stats-report";
import { readTeam } from "@/lib/team";
import { can } from "@/lib/team-roles";
import { readSalesGoal } from "@/lib/sales-goal";
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
  const [got] = await redisPipeline([["SET", "nl:weekly:lock", "1", "NX", "EX", 120]]);
  if (got === null) return Response.json({ ok: true, busy: true });

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
      const chat = await chatAddress(store.statsId).catch(() => null);
      if (emailOff && !chat) {
        out.stopped += 1;
        continue;
      }
      if (!(await claimWeek(store.handle))) continue;
      out.looked += 1;
      const data = await readNumbers(store).catch(() => null);
      // Its rates, for the ranges stores its size are set beside (lib/benchmarks.ts): read here anyway.
      await recordSample(store, data);
      const token = weeklyToken(store.handle);
      const stopUrl = `${SITE_URL}/api/store/weekly?h=${encodeURIComponent(store.handle)}&t=${encodeURIComponent(token)}`;
      const spends = await readSpends(store.statsId).catch(() => []);
      const goal = (await readSalesGoal(store.statsId, store.currency).catch(() => ({ cents: 0 }))).cents;
      const message = data && token ? weeklyMessage(store, data, stopUrl, spends, goal) : null;
      if (!message) {
        out.quiet += 1;
        continue;
      }
      // A few sentences written from the same numbers, first, where the creator turned it on (lib/numbers-ask.ts).
      if (store.weeklyAi && data && aiAvailableFor(store)) {
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
    await redisPipeline([["DEL", "nl:weekly:lock"]]).catch(() => undefined);
  }
}
