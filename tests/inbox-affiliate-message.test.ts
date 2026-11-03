/**
 * The creator writes first to one of their affiliates, through the store's
 * inbox (630 [HN6](5), unit 1: lib/inbox.ts writeToAffiliate). Checked with
 * the real code, a stubbed Redis and the email provider intercepted:
 *
 *   - a conversation of its own, marked "affiliate", begun by the store's
 *     message, answered and waiting for nobody;
 *   - the affiliate emailed the message in the store's language, from the
 *     store, replies to the creator's address, with the link back only while
 *     the store's chat is open (otherwise, "answer this email");
 *   - the affiliate's answer through that link reaches the inbox like any
 *     visitor's, and the creator's reply goes to them;
 *   - refused, before anything is written or counted, for a short text, an
 *     address that is not one or a suspended store; counted as one of the
 *     store's inbox conversations; under a daily cap of its own, so a creator
 *     writing to many affiliates never closes the chat to buyers;
 *   - the affiliate not told (the provider down): the conversation is kept
 *     and `emailed` says so;
 *   - no suggested answer written for it as if it were a customer's;
 *   - the affiliate deleted from the store: the conversation goes with them.
 */
import { parseConversation } from "@/lib/inbox-rules";
import { forgetInboxPerson, openConversation, readInbox, replyTo, startChat, suggestReply, visitorSend, visitorThread, writeToAffiliate } from "@/lib/inbox";
import { CHAT_WORDS } from "@/lib/buyer-words/chat";
import { claimHandle, ensureStatsId, setInboxSetting, setLanguage, setSubscription, storeForEmail, storeForHandle } from "@/lib/store";
import { allowanceUsed } from "@/lib/store-allowance";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

process.env.RESEND_API_KEY = "re_test_inbox_affiliate_only";

const sent: { to: string; subject: string; text: string; replyTo?: string }[] = [];
let providerDown = false;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status });
  if (url.hostname === "api.resend.com") {
    if (providerDown) return json({ message: "down" }, 500);
    const body = JSON.parse(String(init?.body)) as { to: string | string[]; subject: string; text: string; reply_to?: string };
    sent.push({ to: [body.to].flat()[0], subject: body.subject, text: body.text, replyTo: body.reply_to });
    return json({ id: `email_${sent.length}` });
  }
  return json({ object: "list", data: [], has_more: false });
}) as typeof fetch;

const OWNER = "owner@example.com";
const ANA = "ana.partner@example.com";

async function main(): Promise<void> {
  redis.clear();
  await claimHandle(OWNER, "cocina", "Cocina de Ana", "");
  await ensureStatsId(OWNER);
  await setSubscription(OWNER, { customerId: "cus_AffMsg00001", subscriptionId: "sub_AffMsg00001", active: true, tier: "pro", trialEnds: 0, period: paidPeriod() });
  let store = (await storeForEmail(OWNER))!;

  part("Refused before anything is written or counted");
  const before = await allowanceUsed(store, "inbox");
  is("an address that is not one", await writeToAffiliate(store, { email: "nope" }, "Hello, a new banner is ready for you.", OWNER), { ok: false, reason: "email" });
  is("too few words", await writeToAffiliate(store, { email: ANA }, "x", OWNER), { ok: false, reason: "short" });
  is("nothing kept, nothing counted, nothing sent", [(await readInbox(store.statsId)).length, await allowanceUsed(store, "inbox"), sent.length], [0, before, 0]);

  part("The store's chat closed: the email is the way back");
  const first = await writeToAffiliate(store, { email: ANA, name: "Ana" }, "Hello Ana, our spring course opens Monday. A new banner is ready for you.", OWNER);
  is("written", first.ok, true);
  const conversation = first.ok ? first.thread.conversation : null;
  is("its own conversation, marked affiliate, begun by the store", [conversation?.source, conversation?.lastFrom, conversation?.unread, conversation?.email], ["affiliate", "store", 0, ANA]);
  is("its first message is the store's, with who wrote it", first.ok ? first.thread.messages.map((m) => [m.from, m.by]) : [], [["store", OWNER]]);
  is("counted as one of the store's inbox conversations", await allowanceUsed(store, "inbox"), before + 1);
  const mail = sent.find((m) => m.to === ANA);
  is("the affiliate is emailed, in the store's words", mail?.subject, CHAT_WORDS.en.affiliateSubject("Cocina de Ana"));
  is("with the message itself", mail?.text.includes("our spring course opens Monday"), true);
  is("answers go to the creator's own address", mail?.replyTo, OWNER);
  is("with the chat closed, no link: answer the email", [mail?.text.includes("?chat="), mail?.text.includes(CHAT_WORDS.en.replyByEmail)], [false, true]);
  is("the creator is not emailed about their own message", sent.filter((m) => m.to === OWNER).length, 0);
  is("read back from the inbox as an affiliate's conversation", (await readInbox(store.statsId)).map((c) => c.source), ["affiliate"]);
  is("a stored conversation keeps the mark when read again", parseConversation(JSON.stringify({ ...conversation, source: "affiliate" }))?.source, "affiliate");

  part("The store's chat open: a link back, and the answer reaches the inbox");
  await setInboxSetting(OWNER, { chat: true, saved: [] });
  await setLanguage(OWNER, "es");
  store = (await storeForEmail(OWNER))!;
  sent.length = 0;
  const second = await writeToAffiliate(store, { email: ANA }, "Hola Ana, ¿puedes compartir el nuevo curso esta semana?", OWNER);
  const back = sent.find((m) => m.to === ANA);
  is("in the store's language", back?.subject, CHAT_WORDS.es.affiliateSubject("Cocina de Ana"));
  const token = /\?chat=([A-Za-z0-9_-]{32})/.exec(back?.text ?? "")?.[1] ?? "";
  is("with the link back to the conversation", token.length, 32);
  is("which opens it for the affiliate", (await visitorThread(token))?.messages.map((m) => m.from), ["store"]);
  await visitorSend(token, "¡Claro! Lo comparto el jueves.", (h) => storeForHandle(h));
  const id = second.ok ? second.thread.conversation.id : "";
  const opened = await openConversation(store.statsId!, id, store);
  is("the affiliate's answer is in the inbox, waiting for the creator", [opened?.messages.map((m) => m.from), opened?.conversation.lastFrom], [["store", "visitor"], "visitor"]);
  sent.length = 0;
  const reply = await replyTo(store, id, OWNER, "¡Gracias, Ana!");
  is("and the creator's reply goes to the affiliate", [reply.ok, sent.filter((m) => m.to === ANA).length], [true, 1]);

  part("No suggested answer as if the affiliate were a customer");
  is("the writing help is not asked for it", await suggestReply(store, id), { ok: false, reason: "off" });

  part("The affiliate not told: the conversation is kept, and says so");
  providerDown = true;
  const untold = await writeToAffiliate(store, { email: "bea.partner@example.com" }, "Hola Bea, hay un nuevo banner para ti.", OWNER);
  providerDown = false;
  is("kept, and emailed false for the creator to see", [untold.ok, untold.ok ? untold.emailed : null], [true, false]);

  part("A cap of its own, apart from the visitors'");
  let written = 0;
  let last: Awaited<ReturnType<typeof writeToAffiliate>> = { ok: false, reason: "closed" };
  for (let i = 0; i < 80; i += 1) {
    last = await writeToAffiliate(store, { email: `aff${i}@example.com` }, "A short note about this week's launch.", OWNER);
    if (!last.ok) break;
    written += 1;
  }
  is("a day's notes to affiliates are capped", [last, written > 0 && written <= 50], [{ ok: false, reason: "limited" }, true]);
  const visitor = await startChat({ store, email: "buyer@example.com", name: "Buyer", text: "Is the course in Spanish?", ip: "10.0.0.7" });
  is("and a buyer can still start a chat", visitor.ok, true);

  part("Never from a suspended store");
  is("closed", await writeToAffiliate({ ...store, suspended: true } as unknown as typeof store, { email: ANA }, "Hola Ana, una nota más.", OWNER), { ok: false, reason: "closed" });

  part("The affiliate deleted from the store: the conversation goes with them");
  await forgetInboxPerson(store.statsId, ANA);
  is("none left with their address", (await readInbox(store.statsId)).filter((c) => c.email === ANA).length, 0);
  is("and the link back opens nothing", await visitorThread(token), null);

  part("Every language has the words");
  is("subject and opening line, naming the store", Object.values(CHAT_WORDS).every((w) => w.affiliateSubject("«S»").includes("«S»") && w.affiliateIntro("«S»").includes("«S»")), true);

  done();
}

void main();
