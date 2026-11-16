/**
 * The emails of the numbers email to addresses outside a store's team
 * (405 [HX1]): the invitation (unit 5) and, later, the report itself.
 * Each is one of the store's own emails (lib/store-allowance-rules.ts,
 * "email"), taken from its figure before it goes (lib/email.ts, the store
 * meter): when the figure is spent, it is not sent, and the caller says so.
 * Plain text, in US English, with the store's name, why the address gets it
 * and the link to say no or stop. Never sent in a test: tests stand in for
 * the sender.
 */
import { NIMBUS_FROM, sendEmail } from "@/lib/email";
import { SITE_URL } from "@/lib/site-url";
import type { Store } from "@/lib/store";
import { FIGURE_WORDS, INVITE_DAYS, type ReportEvery, type ReportFigure } from "@/lib/report-guests-rules";
import type { Invite } from "@/lib/report-guests";

export const confirmUrl = (token: string) => `${SITE_URL}/api/numbers-guest/confirm?t=${encodeURIComponent(token)}`;
export const leaveUrl = (token: string) => `${SITE_URL}/api/numbers-guest/leave?t=${encodeURIComponent(token)}`;

/** The store's name as an email says it: its name, or its address on the site. */
export const storeWords = (store: Pick<Store, "name" | "handle">) => (store.name?.trim() ? store.name.trim() : `@${store.handle}`);

/** The invitation: what the store wants to send, how often, and the two links. */
export function inviteMessage(store: Pick<Store, "name" | "handle">, every: ReportEvery, figures: ReportFigure[], invite: Pick<Invite, "confirmToken" | "leaveToken">): { subject: string; text: string } {
  const name = storeWords(store);
  const what = figures.length ? figures.map((figure) => `- ${FIGURE_WORDS[figure]}`).join("\n") : "- None picked yet. Nothing is sent until the store picks some.";
  return {
    subject: `${name} wants to email you its numbers`,
    text: [
      `${name} (@${store.handle} on Marktmorgen) wants to email you these numbers of its store every ${every}:`,
      what,
      "",
      `Nothing is sent to you unless you say yes. To say yes, open this link within ${INVITE_DAYS} days:`,
      confirmUrl(invite.confirmToken),
      "",
      "If you do not want these emails, you can ignore this one. Or say no here, and nothing more comes:",
      leaveUrl(invite.leaveToken),
      "",
      `You got this email because the owner of ${name} typed your address in their studio. It does not add you to any mailing list.`,
    ].join("\n"),
  };
}

/** Sends each invitation, each taken from the store's emails before it goes; the addresses whose invitation did not go. */
export async function sendInvites(store: Store, share: { every: ReportEvery; figures: ReportFigure[] }, invites: Invite[]): Promise<string[]> {
  const notSent: string[] = [];
  for (const invite of invites) {
    const message = inviteMessage(store, share.every, share.figures, invite);
    const sent = await sendEmail({
      meter: { by: "store", store, kind: "email" },
      from: NIMBUS_FROM,
      to: invite.address,
      subject: message.subject,
      text: message.text,
      headers: { "List-Unsubscribe": `<${leaveUrl(invite.leaveToken)}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" },
    }).catch(() => false);
    if (!sent) notSent.push(invite.address);
  }
  return notSent;
}
