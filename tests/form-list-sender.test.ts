/**
 * The address a form offers the list to, asks to join and starts sequences
 * for (lib/forms.ts, readAnswers' `email`, read by app/api/store/form) is the
 * response's sender by the one rule the copy, the erasure and the deal read
 * (lib/form-respondent.ts, respondentOf). It used to be the first email
 * question that held an address, so in a form with "Invite a friend (email)"
 * before "Your email" the friend was sent the list's confirmation email, and,
 * when already on the list, started on the form's sequences, on somebody
 * else's say-so. When two email questions hold different addresses, who sent
 * the response cannot be told, and nobody is offered the list or started on
 * anything; the answers are still kept for the creator.
 */
import { readFileSync } from "node:fs";
import { parseForm, readAnswers } from "@/lib/forms";
import { done, is, part } from "./check";

const TESS = "tess@example.com";
const OLLY = "olly@example.com";

function main(): void {
  const invite = parseForm({
    id: "invitefrm1",
    name: "Invite",
    fields: [
      { id: "friend", type: "email", label: "Invite a friend (email)", required: false },
      { id: "yours1", type: "email", label: "Your email", required: true },
      { id: "name01", type: "short", label: "Your name", required: false },
    ],
    offerList: true,
  })!;
  const sent = (values: Record<string, string[]>) => readAnswers(invite, (name) => values[name] ?? []);

  part("Two email questions with different addresses: nobody is offered the list");
  const both = sent({ q_friend: [TESS], q_yours1: [OLLY], q_name01: ["Olly Grant"] });
  is("no address for the list, not the friend's", both.ok ? both.email : "refused", "");
  is("the answers are still kept for the creator", both.ok ? both.answers : null, { friend: TESS, yours1: OLLY, name01: "Olly Grant" });

  part("One sender: their address");
  const own = sent({ q_yours1: [OLLY] });
  is("the friend's question left empty: the sender's own address", own.ok ? own.email : "refused", OLLY);
  const twice = sent({ q_friend: ["Olly@Example.com"], q_yours1: [OLLY] });
  is("the same address in both: that address", twice.ok ? twice.email : "refused", OLLY);

  part("The route offers the list and starts sequences only for that address");
  const route = readFileSync("app/api/store/form/route.ts", "utf8");
  is("askToJoin, leadAffiliate and enroll read read.email, nothing else typed", [
    route.includes("askToJoin({ store, email: read.email,"),
    route.includes('leadAffiliate(store, "signup", visitCookies(request, store.handle), read.email)'),
    route.includes("if (read.email) await enroll(store, read.email,"),
    /read\.answers\[/.test(route),
  ], [true, true, true, false]);

  part("The privacy policy says so");
  const privacy = readFileSync("app/privacy/page.tsx", "utf8").replace(/\s+/g, " ");
  is("the confirmation goes only to the sender, and to nobody when not known", privacy.includes("the email that asks them to confirm goes only to the address that sent the response, and to nobody when the sender cannot be told"), true);
  done();
}

main();
