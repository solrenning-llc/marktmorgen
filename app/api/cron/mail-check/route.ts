import type { NextRequest } from "next/server";
import { cronAllowed } from "@/lib/request-guard";
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { NIMBUS_FROM, isSenderConfigured, sendEmail } from "@/lib/email";
import { type Check, verifyAmazonAccount, verifyHostToken, verifyMailLoop, verifyProviderUsage } from "@/lib/verify-mail";
import { SUPPORT_EMAIL } from "@/lib/creator-research";
import { timed, withCutoff } from "@/lib/fetch-timeout";

// The senders announce a bounce within seconds and a spam report within a
// minute or so; the run waits up to a hundred seconds for both.
export const maxDuration = 180;

const LAST = "nl:mail-check:last";
const WAIT_MS = 100_000;
const RUN_MS = 160_000;

/**
 * Run every day by Vercel: a list email's bounce and spam report, all the way
 * out through each sender and back (lib/verify-mail.ts), and the token and
 * key Amazon is reached with. The last answer is kept; the site's own inbox
 * hears when a check fails, and again when all pass after a failure. Nobody
 * else can start it: only Vercel's scheduled call carries the secret.
 */
export async function GET(request: NextRequest) {
  const started = Date.now();
  return withCutoff(started + RUN_MS, () => timed(RUN_MS, async () => {
    if (!(await cronAllowed(request))) {
      return new Response("Unauthorized", { status: 401, headers: { "Cache-Control": "no-store" } });
    }
    if (!isRedisConfigured() || !isSenderConfigured()) {
      return Response.json({ ok: false, error: "unavailable" }, { status: 503 });
    }
    const [got] = await redisPipeline([["SET", "nl:mail-check:lock", "1", "NX", "EX", 170]]);
    if (got === null) return Response.json({ ok: true, busy: true });
    try {
      let accountChecks: Check[];
      let accountFailed = false;
      try {
        // A cold session may need Redis, STS and GetAccount in sequence.
        // Warm it before collection without cutting the delivery loop short.
        accountChecks = [...verifyHostToken(), ...(await timed(30_000, () => verifyAmazonAccount()))];
      } catch (error) {
        accountFailed = true;
        accountChecks = [{ check: "the run itself", ok: false, detail: error instanceof Error ? error.message : "failed" }];
      }
      const loopDeadline = Date.now() + WAIT_MS;
      const [usage, checks] = await Promise.all([
        verifyProviderUsage(),
        (async (): Promise<Check[]> => {
          if (accountFailed) return accountChecks;
          try {
            return [
              ...accountChecks,
              ...(await timed(Math.max(0, loopDeadline - Date.now()), () => verifyMailLoop(loopDeadline))),
            ];
          } catch (error) {
            return [{ check: "the run itself", ok: false, detail: error instanceof Error ? error.message : "failed" }];
          }
        })(),
      ]);
      const ok = checks.length > 0 && checks.every((c) => c.ok);
      // In Vercel's logs for every run, passing or not.
      console.log(`mail-check ${ok ? "pass" : "FAIL"}: ${checks.map((c) => `${c.ok ? "PASS" : "FAIL"} ${c.check} (${c.detail})`).join(" | ")}`);
      const [previous] = await redisPipeline([["GET", LAST]]);
      // Only the delivery result controls existing notices. A nested usage
      // failure is evidence missing, not a failed bounce/complaint loop.
      let failedBefore = false;
      if (typeof previous === "string") {
        try {
          const prior: unknown = JSON.parse(previous);
          failedBefore = !!prior && typeof prior === "object" && !Array.isArray(prior) &&
            Object.prototype.hasOwnProperty.call(prior, "ok") &&
            (prior as { ok?: unknown }).ok === false;
        } catch { /* Malformed history is not proof of an earlier failure. */ }
      }
      await redisPipeline([["SET", LAST, JSON.stringify({ at: Date.now(), ok, checks, usage }), "EX", 30 * 86_400]]);
      if (!ok || failedBefore) {
        await sendEmail({ meter: { by: "company" },
          from: NIMBUS_FROM,
          to: SUPPORT_EMAIL,
          subject: ok ? "Mail check: all passing again" : "Mail check failed: a bounce or a spam report is not finding its way back",
          text: [
            ok
              ? "Every check of the way a bounce and a spam report travel back from the senders passes again."
              : "A check of the way a bounce or a spam report travels back from a sender failed. Until it passes, a store with a bad list may not be stopped by itself.",
            "",
            ...checks.map((c) => `${c.ok ? "PASS" : "FAIL"}  ${c.check}\n      ${c.detail}`),
          ].join("\n"),
        }).catch((error) => console.error("sending the mail check result failed", error));
      }
      return Response.json({ ok, checks, usage }, { headers: { "Cache-Control": "no-store" } });
    } finally {
      await redisPipeline([["DEL", "nl:mail-check:lock"]]).catch(() => {});
    }
  })).catch(() => Response.json({ ok: false, error: "unavailable" }, {
    status: 503, headers: { "Cache-Control": "no-store" },
  }));
}
