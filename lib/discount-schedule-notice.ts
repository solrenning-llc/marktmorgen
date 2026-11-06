/**
 * The email that a scheduled discount code could not be switched on (511
 * [CK3], unit 2). Sent to the creator's sign-in address once for each code
 * that reaches "Activation failed" (lib/discount-schedule.ts decides when,
 * and keeps it to once): which code, that it is still off, and how to switch
 * it on by hand in the studio. Past its end, it says the code ran out instead.
 *
 * What it costs: one email from the store's own email figure, taken before it
 * goes (lib/email.ts, meter "store", kind "email"); one that does not fit is
 * not sent, and the job tries it again later a bounded number of times
 * (NOTICE_TRIES, lib/discount-schedule-rules.ts). Plain text in plain American English, short lines, no
 * links that sign anybody in, no urgency or scarcity.
 *
 * Alert choices: the creator's per-event alert switches (601 [KB22], unit 6)
 * are not on main yet, so this email does not read them; once they are, it
 * belongs with the notices that say buyers cannot use something the creator
 * set up.
 */
import { NIMBUS_FROM, isSenderConfigured, sendEmail } from "@/lib/email";
import type { ScheduleEntry } from "@/lib/discount-schedule-rules";
import { SITE_URL } from "@/lib/site-url";
import type { Store } from "@/lib/store";

const SUPPORT = "support@marktmorgen.com";

/** A moment in UTC, spelled out: "November 27, 2026, 2:00 PM UTC". */
function utcMoment(seconds: number): string {
  const text = new Date(seconds * 1000).toLocaleString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: "UTC",
  });
  return `${text} UTC`;
}

/** The subject and the plain text body. Pure, so each sentence is held by a test. */
export function failureNotice(
  store: Pick<Store, "sid"> & { name?: string },
  entry: Pick<ScheduleEntry, "code" | "start" | "end">,
  nowSeconds: number,
  site = SITE_URL,
): { subject: string; text: string } {
  const code = entry.code;
  const studio = `${site}/studio${store.sid ? `?store=${store.sid}` : ""}#discount-codes`;
  const shop = store.name ? ` on ${store.name}` : "";
  const subject = `Your discount code ${code} did not switch on`;
  if (nowSeconds >= entry.end) {
    return {
      subject,
      text: [
        `Your discount code ${code} was set to run${shop} from ${utcMoment(entry.start)} to ${utcMoment(entry.end)}.`,
        "We could not switch it on before its end.",
        "Its end has passed, so it can no longer be used.",
        "",
        "If you still want a code, make a new one in your studio:",
        studio,
        "",
        "We send this email only once for this code.",
      ].join("\n"),
    };
  }
  return {
    subject,
    text: [
      `Your discount code ${code} was set to start${shop} on ${utcMoment(entry.start)}.`,
      "We could not switch it on. Stripe did not confirm it.",
      "The code is still off, so buyers cannot use it yet.",
      "",
      "To switch it on yourself, in your studio:",
      `1. Open ${studio}`,
      `2. Under Discount codes, choose "Load discount codes".`,
      `3. Find ${code} under "Waiting for their start". Choose "Cancel ${code}". It stays off.`,
      `4. Choose "Make a code". Type ${code} again. Leave "Start and end it at set times" unchecked.`,
      "It works as soon as you make it.",
      "",
      `A code made this way has no end. Switch it off in your studio when your sale is over.`,
      `To keep its end (${utcMoment(entry.end)}), switch it on in your Stripe dashboard instead, where the code is kept.`,
      "",
      "We send this email only once for this code.",
      `Questions? Write to ${SUPPORT}.`,
    ].join("\n"),
  };
}

/**
 * Sends the email for one failed code. Never throws; false when nothing was
 * sent (no sender, the store's email figure spent, or the send refused), so
 * the job may try again, up to NOTICE_TRIES times in all.
 */
export async function tellActivationFailed(store: Store, entry: ScheduleEntry, nowSeconds: number): Promise<boolean> {
  if (!isSenderConfigured() || !store.email) return false;
  const { subject, text } = failureNotice(store, entry, nowSeconds);
  try {
    return await sendEmail({
      meter: { by: "store", store, kind: "email" },
      from: NIMBUS_FROM,
      to: store.email,
      replyTo: SUPPORT,
      subject: subject.slice(0, 180),
      text,
    });
  } catch (error) {
    console.error("emailing that a scheduled discount code failed did not work", error);
    return false;
  }
}
