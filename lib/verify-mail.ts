/**
 * The whole way a bounce travels, run against the real senders, every day,
 * by a scheduled job (app/api/cron/mail-check).
 *
 * The protection in lib/mail-health.ts depends on a chain no test in this
 * repository can hold together, because half of it is somebody else's: the
 * sender takes a list email with its tags, a mailbox refuses it, the sender
 * announces that to our address with the tags still on it, the announcement
 * is believed, and the address comes off the list. If any link is changed on
 * the sender's side — a tag dropped, an event renamed — nothing here fails
 * and nothing says so; the protection is simply no longer there.
 *
 * So once a day a list that is nobody's is made, with two addresses on it
 * that each sender keeps for exactly this:
 *
 *   Resend      bounced@resend.dev, complained@resend.dev
 *               (resend.com/docs/dashboard/emails/send-test-emails)
 *   Amazon SES  bounce@simulator.amazonses.com,
 *               complaint@simulator.amazonses.com
 *               (docs.aws.amazon.com/ses/latest/dg/send-an-email-from-console.html)
 *
 * Both say these do not count against a sender's reputation (read October 6,
 * 2026). One email goes to each, tagged as a list email is, through the
 * sender being checked and no other. The check passes when each address has
 * come off the list and been counted, which only happens if every link held.
 * Then the list and everything counted for it are taken away again.
 *
 * Two more things are looked at while here, because the day they go wrong is
 * otherwise found out by an email not arriving:
 *
 *   - the token the host gives each request is the one Amazon is told to
 *     trust (lib/ses.ts, TRUSTED_TOKEN);
 *   - Amazon lends a key for it and says what the account may do.
 *
 * A sender that is not set up is not checked, and is said so, not failed.
 */
import { randomBytes } from "node:crypto";
import { NIMBUS_FROM, hasResend, sendBatch } from "@/lib/email";
import { canHearResend } from "@/lib/inbound-mail";
import { agreedKey, isMailable, leadsKey, unsubKey, upsertContact } from "@/lib/contacts";
import { LIST_TAG, STORE_TAG, forgetHealth, listHealth } from "@/lib/mail-health";
import { redisPipeline } from "@/lib/redis";
import { TRUSTED_TOKEN, hostTokenClaims, isSesConfigured, sesConfig, sesState } from "@/lib/ses";
import { timed, withCutoff } from "@/lib/fetch-timeout";
import { resendAccountUsage, resendUsageSince, type ResendAccountUsage, type ResendUsage } from "@/lib/resend-usage";
import { sesProviderUsage, type SesProviderUsage } from "@/lib/ses-provider-usage";

export type Check = { check: string; ok: boolean; detail: string };

/**
 * Separate provider observations, never send admission or billed units.
 * SES is a rolling counter observed between its request and response clocks.
 * Resend's sent metric covers the exact requested UTC range; neither source
 * proves a simultaneous snapshot or equivalent recipients/billing units.
 */
export type MailProviderUsageReport = {
  basis: "provider_reported_counters";
  window: { from: string; through: string } | null;
  ses: SesProviderUsage;
  resend: ResendUsage;
  resendAccount: ResendAccountUsage;
  alignment: {
    anchor: "collector_start_utc";
    exactSameWindow: false;
    billingUnitsComparable: false;
  };
};

/**
 * At most one usage GET per provider plus Resend /usage; a cold SES session
 * may also borrow credentials. No probe or notification is sent here.
 * The outer limits also cover credential exchange bodies before GetAccount.
 */
export async function verifyProviderUsage(now = Date.now()): Promise<MailProviderUsageReport> {
  const alignment = {
    anchor: "collector_start_utc", exactSameWindow: false, billingUnitsComparable: false,
  } as const;
  const basis = "provider_reported_counters" as const;
  const day = 86_400_000;
  if (!Number.isSafeInteger(now) || now < day || now > 8_640_000_000_000_000) {
    return {
      basis, window: null, alignment,
      ses: { ok: false, reason: "unknown" },
      resend: { ok: false, reason: "unknown" },
      resendAccount: { ok: false, reason: "unknown" },
    };
  }
  const from = now - day;
  return withCutoff(now + 30_000, async () => {
    const [ses, resend, resendAccount] = await Promise.all([
      timed(30_000, () => sesProviderUsage(now)).catch((): SesProviderUsage => ({ ok: false, reason: "provider" })),
      timed(30_000, () => resendUsageSince(from, now)).catch((): ResendUsage => ({ ok: false, reason: "provider" })),
      timed(30_000, () => resendAccountUsage()).catch((): ResendAccountUsage => ({ ok: false, reason: "provider" })),
    ]);
    return {
      basis, window: { from: new Date(from).toISOString(), through: new Date(now).toISOString() },
      ses, resend, resendAccount, alignment,
    };
  });
}

type Sender = "resend" | "amazon";
const NAMES: Record<Sender, string> = { resend: "Resend", amazon: "Amazon SES" };
const ADDRESSES: Record<Sender, { bounced: string; complained: string }> = {
  resend: { bounced: "bounced+{label}@resend.dev", complained: "complained+{label}@resend.dev" },
  amazon: { bounced: "bounce+{label}@simulator.amazonses.com", complained: "complaint+{label}@simulator.amazonses.com" },
};

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Whether the host's token is the one Amazon is told to trust. */
export function verifyHostToken(now = Date.now()): Check[] {
  const check = "the host's token is the one Amazon is told to trust";
  const claims = hostTokenClaims();
  if (!claims) return [{ check, ok: false, detail: "this request carries no token from the host" }];
  const wrong = (["iss", "aud", "sub"] as const).filter((name) => claims[name] !== TRUSTED_TOKEN[name]);
  const left = Math.round(claims.exp - now / 1000);
  if (wrong.length) {
    return [{ check, ok: false, detail: wrong.map((name) => `${name} is "${claims[name]}", and Amazon is told "${TRUSTED_TOKEN[name]}"`).join("; ") }];
  }
  return [{ check, ok: left > 0, detail: left > 0 ? `issuer, audience and subject as in infra/amazon-ses.yml; good for ${Math.round(left / 60)} more minutes` : "the token is past its time" }];
}

/** Whether Amazon lends a key and says what the account may do. Nothing when Amazon is not set up. */
export async function verifyAmazonAccount(): Promise<Check[]> {
  if (!isSesConfigured() || !sesConfig()) return [];
  const check = "Amazon lends a key and says what the account may do";
  const state = await sesState();
  if (!state) return [{ check, ok: false, detail: "no answer could be kept" }];
  if (state.why === "key" || state.why === "unreachable") {
    return [{ check, ok: false, detail: state.why === "key" ? "Amazon would not lend a key, or did not believe it" : "Amazon did not answer" }];
  }
  const limits = `${state.max24 > 0 ? state.max24.toLocaleString("en-US") : "no limit of"} emails in 24 hours, ${state.rate || "?"} a second`;
  return [{ check, ok: true, detail: state.ready ? `sending through Amazon: ${limits}` : `not sending through Amazon yet (${state.why}); ${limits}` }];
}

/**
 * One sender's loop: a tagged email to its bounce address and one to its
 * complaint address, and each must come off the made-up list and be counted
 * before `deadline`.
 */
async function loop(sender: Sender, deadline: number): Promise<Check[]> {
  const name = NAMES[sender];
  const store = randomBytes(16).toString("hex");
  const list = randomBytes(16).toString("hex");
  const label = randomBytes(4).toString("hex");
  const to = { bounced: ADDRESSES[sender].bounced.replace("{label}", label), complained: ADDRESSES[sender].complained.replace("{label}", label) };
  const kinds = ["bounced", "complained"] as const;
  const started = Date.now();
  try {
    for (const kind of kinds) await upsertContact(list, to[kind], { agreed: true, explicit: true, source: "import" }, null);
    const sent = await sendBatch(
      kinds.map((kind) => ({
        from: NIMBUS_FROM,
        to: to[kind],
        subject: "Marktmorgen delivery check",
        text: "This email is sent once a day to an address the sender keeps for testing, to check that a bounce or a spam report still finds its way back.",
        html: "<p>This email is sent once a day to an address the sender keeps for testing, to check that a bounce or a spam report still finds its way back.</p>",
        tags: { [STORE_TAG]: store, [LIST_TAG]: list },
      })),
      `mail-check:${sender}:${label}`, { by: "company" },
      sender,
    );
    if (sent !== "sent") {
      return [{ check: `${name} takes a list email`, ok: false, detail: `it answered "${sent}"` }];
    }
    const heard: Record<(typeof kinds)[number], number> = { bounced: 0, complained: 0 };
    while (Date.now() < deadline && (!heard.bounced || !heard.complained)) {
      await pause(3_000);
      for (const kind of kinds) {
        if (!heard[kind] && !(await isMailable(list, to[kind]))) heard[kind] = Date.now() - started;
      }
    }
    const counted = await listHealth(store);
    const waited = Math.round((Date.now() - started) / 1000);
    return [
      {
        check: `${name}: a list email's bounce comes back with its tags and takes the address off`,
        ok: heard.bounced > 0 && counted.bounced === 1,
        detail: heard.bounced ? `off the list ${Math.round(heard.bounced / 1000)}s after sending, counted ${counted.bounced} time` : `nothing heard in ${waited}s`,
      },
      {
        check: `${name}: a spam report comes back with its tags and takes the address off`,
        ok: heard.complained > 0 && counted.complained === 1,
        detail: heard.complained ? `off the list ${Math.round(heard.complained / 1000)}s after sending, counted ${counted.complained} time` : `nothing heard in ${waited}s`,
      },
    ];
  } finally {
    // The list was nobody's: it, and all that was counted for it, go.
    await redisPipeline([["DEL", leadsKey(list), agreedKey(list), unsubKey(list)]]).catch(() => {});
    await forgetHealth(store, [to.bounced, to.complained]).catch(() => {});
  }
}

/** Every sender that is set up, one after the other, sharing the time until `deadline`. */
export async function verifyMailLoop(deadline: number): Promise<Check[]> {
  const out: Check[] = [];
  const senders: Sender[] = [];
  if (hasResend() && canHearResend()) senders.push("resend");
  else out.push({ check: "Resend's loop", ok: true, detail: "not checked: Resend, or the secret that signs its announcements, is not set" });
  const amazon = isSesConfigured() ? await sesState() : null;
  if (amazon?.ready) senders.push("amazon");
  else out.push({ check: "Amazon SES's loop", ok: true, detail: `not checked: ${amazon ? `Amazon is not sending yet (${amazon.why})` : "Amazon is not set up"}` });
  // Both at once: each waits on its own sender, and neither on the other.
  const results = await Promise.all(senders.map((sender) => loop(sender, deadline).catch((error): Check[] => [{ check: `${NAMES[sender]}'s loop`, ok: false, detail: error instanceof Error ? error.message : "failed" }])));
  return [...results.flat(), ...out];
}
