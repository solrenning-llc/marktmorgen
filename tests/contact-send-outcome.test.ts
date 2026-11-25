/**
 * The contact form answers what the sender knows (board #5285, row #2649: Claude 5's MÉDIO and LEVE 2 on #2649).
 * A send whose answer is not known (the provider timed out or answered 5xx, so it may have been accepted) used to be
 * shown as "We could not send it just now. Try again", and sending again changed nothing for a day, because the
 * message's once-only key holds that long. Now sendContact tells the three apart, by behavior, not by reading its
 * source:
 *
 *   - accepted: "sent", and the message is filed in the studio inbox;
 *   - not known: "uncertain", whose notice says it may have reached the store, that sending it again today does not
 *     send it twice, and when to send it again; the visitor is never told it failed;
 *   - refused for certain: "error", as before.
 *
 * Synthetic only: the Redis stand-in and a Resend stand-in whose answer each case sets.
 */
import { claimHandle, ensureStatsId, setContact, storeForEmail } from "@/lib/store";
import { sendContact } from "@/lib/store-contact";
import { contactWords } from "@/lib/buyer-words/contact";
import { LANGUAGE_CODES } from "@/lib/store-language";
import { store as redis } from "./redis-stub";
import { conversationCount } from "@/lib/inbox";
import { done, is, part } from "./check";

/** The status Resend answers with, and how many sends reached it. */
let status = 200;
let posts = 0;
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input));
  if (url.hostname === "api.resend.com") {
    posts += 1;
    return status === 200 ? new Response(JSON.stringify({ id: `email_${posts}` })) : new Response(JSON.stringify({ message: "stand-in" }), { status });
  }
  return new Response("{}", { status: 404 });
}) as typeof fetch;


async function main(): Promise<void> {
  redis.clear();
  process.env.RESEND_API_KEY = "re_test_contact_only";
  const owner = "outcome@example.com";
  await claimHandle(owner, "outcomeshop", "Outcome Shop", "");
  await ensureStatsId(owner);
  await setContact(owner, { on: true });
  const store = (await storeForEmail(owner))!;
  const send = (ip: string, message: string) => sendContact({ store, name: "Dana", email: "dana@example.com", message, ip });

  part("Accepted by the sender");
  status = 200;
  is("sent", await send("2.2.2.1", "Hello! Could we work together on a cookbook for a magazine?"), "sent");
  is("and filed in the studio inbox", await conversationCount(store.statsId), 1);

  part("An answer that is not known (5xx)");
  status = 503;
  const before = posts;
  is("uncertain, never told it failed", await send("2.2.2.2", "Hello again! I would love to hear about your next workshop dates."), "uncertain");
  is("control: the send did reach the sender stand-in", posts > before, true);

  part("Refused for certain (4xx)");
  status = 422;
  is("error, as before", await send("2.2.2.3", "One more question about the bakery course and its dates, please."), "error");

  part("The notice for an answer that is not known, in every language");
  for (const code of LANGUAGE_CODES) {
    const words = contactWords(code);
    const notice = words.notices.uncertain;
    is(`${code}: there is a notice of its own`, Boolean(notice?.title && notice?.body), true);
    is(`${code}: it is not the failure notice`, notice?.title !== words.notices.error.title && notice?.body !== words.notices.error.body, true);
  }
  const en = contactWords("en").notices.uncertain as { title: string; body: string } | undefined;
  is("en: it says the message may have reached the store", en?.body.includes("may already have reached") ?? false, true);
  is("en: it says sending it again today does not send it twice", en?.body.includes("will not send it twice") ?? false, true);
  done();
}

main().catch((error) => {
  console.log("✗ crashed:", error);
  process.exit(1);
});
