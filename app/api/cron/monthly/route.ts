import type { NextRequest } from "next/server";
import { cronAllowed } from "@/lib/request-guard";
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { NIMBUS_FROM, isSenderConfigured, sendEmail } from "@/lib/email";
import { visitedFolders } from "@/lib/traffic";
import { monthKey } from "@/lib/delivery";
import { storeOf } from "@/lib/usage-billing";
import { standingOf } from "@/lib/plan-standing";
import { claimMonth, lastMonthOf, releaseMonth, monthlyMessage, readNumbers, weeklyOff, weeklyStopUrl } from "@/lib/stats-report";
import { UNKNOWN_SALES_GOAL_CENTS, goalForMonth, readSalesGoal, withGoalAvailability } from "@/lib/sales-goal";
import { chatAddress, forChat, postToChat } from "@/lib/chat-summary";

/**
 * The month's email to each creator whose store had visitors in it
 * (lib/stats-report.ts, monthlyMessage), and the same summary to their Slack
 * or Discord channel where they chose one (lib/chat-summary.ts).
 *
 * Runs every hour on the 1st and the 2nd of the month, at most MAX_PER_RUN
 * stores a run, each claimed for the month before anything is read, so nobody
 * gets two. Only stores with a plan running, paid or in its trial. "Stop" in
 * any numbers email stops this one too; the channel is the creator's own
 * choice and is posted to still.
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
  const [got] = await redisPipeline([["SET", "nl:monthly:lock", "1", "NX", "EX", 120]]);
  if (got === null) return Response.json({ ok: true, busy: true });

  const started = Date.now();
  const out = { looked: 0, sent: 0, posted: 0, quiet: 0, stopped: 0, unpaid: 0, failed: 0 };
  try {
    const month = lastMonthOf(Date.now());
    // The stores that had visitors in the month just ended.
    const folders = await visitedFolders(monthKey(new Date(`${month}-15T00:00:00Z`)));
    for (const folder of folders) {
      if (out.looked >= MAX_PER_RUN || Date.now() - started > TIME_BUDGET_MS) break;
      const store = await storeOf(folder).catch(() => null);
      if (!store) continue;
      const standing = standingOf(store);
      if (standing !== "paid" && standing !== "trial") {
        out.unpaid += 1;
        continue;
      }
      const emailOff = await weeklyOff(store);
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
      if (!(await claimMonth(store.handle, month))) continue;
      out.looked += 1;
      const data = await readNumbers(store).catch(() => null);
      if (!data) {
        // Not read this time: the month is let go, so a later run tries again.
        await releaseMonth(store.handle, month).catch(() => undefined);
        out.failed += 1;
        continue;
      }
      const stopUrl = weeklyStopUrl(store);
      // Only a goal set by the month being reported is measured: one set on the 1st is for the month ahead.
      const kept = await readSalesGoal(store.statsId, store.currency).catch(() => ({ cents: UNKNOWN_SALES_GOAL_CENTS, since: "" }));
      const goal = goalForMonth(kept, month);
      const message = withGoalAvailability(stopUrl ? monthlyMessage(store, data, month, stopUrl, goal) : null, goal);
      if (!message) {
        out.quiet += 1;
        continue;
      }
      if (chat && (await postToChat(chat, `${message.subject}\n\n${forChat(message.text)}`).catch(() => false))) out.posted += 1;
      if (emailOff) continue;
      const ok = await sendEmail({ meter: { by: "company" },
        from: NIMBUS_FROM,
        to: store.email,
        subject: message.subject,
        text: message.text,
        headers: { "List-Unsubscribe": `<${stopUrl}>` },
      }).catch(() => false);
      if (ok) out.sent += 1;
      else out.failed += 1;
    }
    console.log(`monthly: ${JSON.stringify(out)}`);
    return Response.json({ ok: true, ...out }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("monthly emails failed", error);
    return Response.json({ ok: false, error: "failed", ...out }, { status: 500 });
  } finally {
    await redisPipeline([["DEL", "nl:monthly:lock"]]).catch(() => undefined);
  }
}
