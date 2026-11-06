/**
 * The store's inbox (lib/inbox-rules.ts, lib/inbox.ts; added 13 October
 * 2026). Checked:
 *
 *   - the rules: settings read back whole, messages cleaned, addresses,
 *     phone numbers and links taken out of what may go to the writing help,
 *     open conversations first;
 *   - the chat takes nothing while it is off; a visitor with an address and
 *     a few words starts a conversation, and the owner is told once in half
 *     an hour, not for every message;
 *   - the visitor reads their conversation with their token only; a wrong
 *     token opens nothing;
 *   - an answer is kept, shown in their chat, and emailed to them alone in
 *     the store's language with the link back; closing and writing again
 *     opens it again; it can be given only to someone who may answer, who is
 *     then the one told;
 *   - a message sent with the contact form is filed too;
 *   - the suggested answer is asked with the store's own questions and
 *     answers and the conversation, never the visitor's address or name;
 *   - one connection cannot start conversations without end.
 */
import { NO_INBOX, forAi, inboxOrder, messageText, parseInboxSetting, type Conversation } from "@/lib/inbox-rules";
import { assignTo, chatOpen, openConversation, readInbox, replyTo, setStatus, startChat, suggestReply, visitorSend, visitorThread } from "@/lib/inbox";
import { sendContact } from "@/lib/store-contact";
import { claimHandle, ensureStatsId, setContact, setFaq, setInboxSetting, setLanguage, setSubscription, storeForEmail, storeForHandle } from "@/lib/store";
import { advance, store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";
import { allowanceUsed } from "@/lib/store-allowance";

process.env.RESEND_API_KEY = "re_test_inbox_only_a_stand_in";
process.env.ANTHROPIC_API_KEY = `sk-ant-api03-${"x".repeat(40)}`;

const sent: { to: string; subject: string; text: string; replyTo?: string }[] = [];
const asked: { system: string; prompt: string }[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status });
  if (url.hostname === "api.resend.com") {
    const body = JSON.parse(String(init?.body)) as { to: string | string[]; subject: string; text: string; reply_to?: string };
    sent.push({ to: [body.to].flat()[0], subject: body.subject, text: body.text, replyTo: body.reply_to });
    return json({ id: `email_${sent.length}` });
  }
  if (url.hostname === "api.anthropic.com") {
    const body = JSON.parse(String(init?.body)) as { system: string; messages: { content: string }[] };
    asked.push({ system: body.system, prompt: String(body.messages[0].content) });
    return json({ content: [{ type: "text", text: "Hola, el curso incluye 12 lecciones y acceso para siempre." }] });
  }
  return json({ object: "list", data: [], has_more: false });
}) as typeof fetch;

const OWNER = "owner@example.com";
const HELPER = "helper@example.com";

async function main(): Promise<void> {
  redis.clear();

  part("The rules");
  is("off until set, saved replies read strictly", [
    parseInboxSetting(null),
    parseInboxSetting({ chat: true, saved: [{ id: "abc123", title: " Download ", text: "It is in your email." }, { id: "bad", title: "x", text: "y" }, { id: "abc123", title: "Again", text: "Twice" }] }),
  ], [NO_INBOX, { chat: true, saved: [{ id: "abc123", title: "Download", text: "It is in your email." }] }]);
  is("a message keeps its lines, nothing else that is not text", messageText("  Hi\r\n\r\n\r\n\r\nthere\u0007  "), "Hi\n\nthere");
  is("addresses, links and phone numbers are taken out before the writing help", forAi(("Write to ana@example.com or " + ("+" + "1 (555) 123-4567") + ", see https://x.co/a and www.y.com")), "Write to [email] or [number], see [link] and [link]");
  const c = (id: string, status: "open" | "closed", lastAt: number) => ({ id, status, lastAt }) as Conversation;
  is("open conversations first, then the newest", inboxOrder([c("a", "closed", 9), c("b", "open", 1), c("c", "open", 5)]).map((x) => x.id), ["c", "b", "a"]);

  part("A store, its chat off");
  await claimHandle(OWNER, "cocina", "Cocina de Ana", "");
  await ensureStatsId(OWNER);
  await setSubscription(OWNER, { customerId: "cus_Inbox00001", subscriptionId: "sub_Inbox00001", active: true, tier: "pro", trialEnds: 0, period: paidPeriod() });
  await setLanguage(OWNER, "es");
  await setFaq(OWNER, [{ q: "How many lessons?", a: "Twelve, yours for good." }]);
  let store = (await storeForEmail(OWNER))!;
  is("closed while off", [chatOpen(store), (await startChat({ store, email: "ana@example.com", name: "Ana", text: "Hello", ip: "10.0.0.1" })).ok], [false, false]);

  part("A visitor starts a conversation");
  store = (await setInboxSetting(OWNER, { chat: true, saved: [] })).ok ? (await storeForEmail(OWNER))! : store;
  is("open once on", chatOpen(store), true);
  is("an address is needed, and a few words", [
    await startChat({ store, email: "nope", name: "", text: "Hello there", ip: "10.0.0.1" }),
    await startChat({ store, email: "ana@example.com", name: "", text: "x", ip: "10.0.0.1" }),
  ], [{ ok: false, reason: "email" }, { ok: false, reason: "short" }]);
  const started = await startChat({ store, email: "Ana@Example.com", name: "Ana Real", text: ("How many lessons does the course have? Call me on " + ("+" + "1 555 123 4567.")), ip: "10.0.0.1" });
  const token = started.ok ? started.thread.token : "";
  is("started, with a token only the visitor holds", [started.ok, /^[A-Za-z0-9_-]{32}$/.test(token)], [true, true]);
  const told = sent.filter((m) => m.to === OWNER);
  is("the owner told, with a link to answer in the studio", [told.length, told[0]?.subject, /\/studio\/inbox\?(store=[^&]+&)?c=[a-z0-9]{12}/.test(told[0]?.text ?? "")], [1, "New message from Ana Real on Cocina de Ana", true]);
  part("Marked funded incoming messages need the paid resource month");
  const funded = { ...store, period: { ...store.period!, funded: true as const } };
  const inboxBefore = JSON.stringify(await readInbox(store.statsId));
  const messagesBefore = JSON.stringify(await visitorThread(token));
  const allowanceBefore = await allowanceUsed(store, "inbox");
  const sentBeforeFunding = sent.length;
  is("a new funded conversation without actual approval stays closed", await startChat({ store: funded, email: "funded@example.com", name: "Synthetic", text: "This must not open a new conversation.", ip: "10.0.0.99" }), { ok: false, reason: "closed" });
  is("a funded follow-up without actual approval is not written", await visitorSend(token, "This must not add a funded message.", async () => funded), { ok: false, reason: "closed" });
  is("existing conversations and messages remain readable and unchanged", [JSON.stringify(await readInbox(store.statsId)), JSON.stringify(await visitorThread(token))], [inboxBefore, messagesBefore]);
  is("refused incoming work consumes no inbox allowance or supplier email", [await allowanceUsed(store, "inbox"), sent.length], [allowanceBefore, sentBeforeFunding]);

  await visitorSend(token, "Also: is there a certificate?", (h) => storeForHandle(h));
  is("a second message within the half hour: not told again", sent.filter((m) => m.to === OWNER).length, 1);

  part("Read with the token only");
  const seen = await visitorThread(token);
  is("their messages", seen?.messages.map((m) => [m.from, m.text]), [["visitor", ("How many lessons does the course have? Call me on " + ("+" + "1 555 123 4567."))], ["visitor", "Also: is there a certificate?"]]);
  is("a wrong token opens nothing", [await visitorThread("A".repeat(32)), await visitorThread("short")], [null, null]);

  part("The studio");
  const list = await readInbox(store.statsId);
  const id = list[0]?.id ?? "";
  is("one conversation, two unread, waiting", list.map((x) => [x.email, x.name, x.source, x.status, x.unread, x.lastFrom]), [["ana@example.com", "Ana Real", "chat", "open", 2, "visitor"]]);
  is("the studio never sees the token", JSON.stringify(list).includes(token), false);
  await openConversation(store.statsId!, id, store);
  is("read once opened", (await readInbox(store.statsId))[0]?.unread, 0);

  part("The answer");
  const before = sent.length;
  const replied = await replyTo(store, id, OWNER, "Doce lecciones, y sí, hay certificado.");
  const mail = sent[before];
  is("kept and emailed to the visitor alone, in Spanish, with the link back", [
    replied.ok && replied.emailed,
    sent.length - before,
    mail?.to,
    mail?.subject,
    mail?.text.includes(`/@cocina?chat=${token}`),
    mail?.replyTo,
  ], [true, 1, "ana@example.com", "Cocina de Ana respondió a tu mensaje", true, OWNER]);
  const after = await visitorThread(token);
  is("in their chat, without who on the team wrote it", after?.messages.at(-1), { at: after?.messages.at(-1)?.at, from: "store", text: "Doce lecciones, y sí, hay certificado." });

  part("Closed, opened again, given to someone");
  is("closed", (await setStatus(store, id, "closed"))?.status, "closed");
  await visitorSend(token, "Thank you!", (h) => storeForHandle(h));
  is("writing again opens it", (await readInbox(store.statsId))[0]?.status, "open");
  is("only someone who may answer", await assignTo(store, id, "stranger@example.com", [OWNER, HELPER]), null);
  is("given to the helper", (await assignTo(store, id, HELPER, [OWNER, HELPER]))?.assigned, HELPER);
  advance(31 * 60_000);
  await visitorSend(token, "One more question.", (h) => storeForHandle(h));
  is("the helper is the one told now", sent.at(-1)?.to, HELPER);

  part("The contact form files its messages too");
  await setContact(OWNER, { on: true });
  store = (await storeForEmail(OWNER))!;
  is("sent as before", await sendContact({ store, name: "Ben", email: "ben@example.com", message: "Do you do collaborations?", ip: "10.0.0.2" }), "sent");
  const filed = (await readInbox(store.statsId)).find((x) => x.email === "ben@example.com");
  is("and in the inbox", [filed?.source, filed?.name, filed?.unread], ["contact", "Ben", 1]);

  part("A suggested answer");
  const suggestion = await suggestReply(store, id);
  is("written, and counted as one job", [suggestion.ok, suggestion.ok ? suggestion.value : ""], [true, "Hola, el curso incluye 12 lecciones y acceso para siempre."]);
  const prompt = asked[0]?.prompt ?? "";
  is("from the store's questions and answers and the conversation", [prompt.includes("Twelve, yours for good."), prompt.includes("is there a certificate?"), asked[0]?.system.includes("Write in Spanish")], [true, true, true]);
  is("never the visitor's address, name or phone number", [prompt.includes("ana@example.com"), prompt.includes("Ana Real"), prompt.includes("555 123 4567"), prompt.includes("[number]")], [false, false, false, true]);

  part("Not without end");
  const results: boolean[] = [];
  for (let i = 0; i < 6; i += 1) results.push((await startChat({ store, email: `p${i}@example.com`, name: "", text: "Hello there", ip: "10.0.0.9" })).ok);
  is("five from one connection in an hour, then no more", results, [true, true, true, true, true, false]);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
