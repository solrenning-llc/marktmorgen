/**
 * The store's inbox, kept (lib/inbox-rules.ts says what it is for).
 *
 *   nl:inbox:<statsId>:all        zset: conversation id → its last message's time (ms)
 *   nl:inbox:<statsId>:c:<id>     the conversation (JSON), with the visitor's chat token
 *   nl:inbox:<statsId>:m:<id>     list: its messages, oldest first, the newest MAX_MESSAGES
 *   nl:inbox:tok:<token>          "<statsId>|<id>|<handle>": what a visitor's chat opens
 *
 * Every key but the index lives KEEP_DAYS after the conversation's last
 * message; the index drops what has gone the next time it is read, and keeps
 * the newest MAX_CONVERSATIONS.
 *
 * What it keeps takes room in the store's data room (lib/store-data.ts)
 * until it expires by itself: each conversation is counted, whole, in the
 * slot of the month it would expire in were nothing more written (kept on
 * it as `bm`, with what its messages weigh as `b`); a message in the same
 * month adds what it weighs, one in a later month counts the whole again
 * there. A visitor's or a reply's message that does not fit is refused.
 *
 * A visit to the store reads none of this: the chat is drawn from the store
 * record the page already has, and only a visitor who opens it and writes, or
 * comes back to a conversation they started, reaches these keys.
 */
import { takeAllowance } from "@/lib/store-allowance";
import { reservePaidResourceWindow } from "@/lib/contract-resource-window";
import { randomBytes } from "node:crypto";
import { EMAIL_PATTERN, MAX_EMAIL_LENGTH, normaliseEmail } from "@/lib/auth";
import { type AiResult, answerModel, askModel, counted } from "@/lib/ai";
import { storeSender } from "@/lib/calls";
import { NIMBUS_FROM, isSenderConfigured, sendEmail } from "@/lib/email";
import { isHouseStore } from "@/lib/house-store";
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { UnknownReplyError, countOf, repliesFor } from "@/lib/redis-reply";
import { DataRoomError, monthOf, needData, noteData } from "@/lib/store-data";
import { dataBytes } from "@/lib/store-data-rules";
import { withinLimit } from "@/lib/request-guard";
import { SITE_URL } from "@/lib/site-url";
import { LANGUAGES, parseLanguage } from "@/lib/store-language";
import { chatWords } from "@/lib/buyer-words/chat";
import type { Store } from "@/lib/store";
import { stringList } from "@/lib/redis-reply";
import { type Member, readTeam } from "@/lib/team";
import { can } from "@/lib/team-roles";
import {
  CHAT_TOKEN,
  CONVERSATION_ID,
  type Conversation,
  KEEP_DAYS,
  MAX_CONVERSATIONS,
  MAX_MESSAGES,
  MIN_MESSAGE,
  type Message,
  NEW_PER_DAY,
  type Source,
  VISITOR_PER_HOUR,
  forAi,
  inboxOrder,
  messageText,
  nameText,
  parseConversation,
  parseMessage,
} from "@/lib/inbox-rules";

const KEEP = KEEP_DAYS * 86_400;
const indexKey = (statsId: string) => `nl:inbox:${statsId}:all`;
const convKey = (statsId: string, id: string) => `nl:inbox:${statsId}:c:${id}`;
const msgKey = (statsId: string, id: string) => `nl:inbox:${statsId}:m:${id}`;
export const tokenKey = (token: string) => `nl:inbox:tok:${token}`;

type Kept = Conversation & { token: string; b?: number; bm?: string };

const LETTERS = "abcdefghijklmnopqrstuvwxyz0123456789";
function newId(): string {
  const bytes = randomBytes(12);
  return [...bytes].map((b) => LETTERS[b % LETTERS.length]).join("");
}

function parseKept(raw: unknown): Kept | null {
  const conversation = parseConversation(raw);
  if (!conversation) return null;
  try {
    const value = JSON.parse(String(raw)) as { token?: unknown; b?: unknown; bm?: unknown };
    const token = value.token;
    return {
      ...conversation,
      token: typeof token === "string" && CHAT_TOKEN.test(token) ? token : "",
      ...(typeof value.b === "number" && Number.isSafeInteger(value.b) && value.b >= 0 ? { b: value.b } : {}),
      ...(typeof value.bm === "string" && /^\d{4}-\d{2}$/.test(value.bm) ? { bm: value.bm } : {}),
    };
  } catch {
    return null;
  }
}

/** What the studio is given: the conversation without the visitor's token. */
function shown(kept: Kept): Conversation {
  const { token, b, bm, ...conversation } = kept;
  void token;
  void b;
  void bm;
  return conversation;
}

/** Whether the store's pages show the chat. Read from the store record alone: no extra read on a visit. */
export function chatOpen(store: Store): boolean {
  return store.inbox.chat && !store.suspended && !isHouseStore(store) && isRedisConfigured() && Boolean(store.statsId) && Boolean(store.email);
}

function readEmail(raw: unknown): string | null {
  const text = typeof raw === "string" ? raw.trim() : "";
  if (!text || text.length > MAX_EMAIL_LENGTH || !EMAIL_PATTERN.test(text)) return null;
  return normaliseEmail(text);
}

/**
 * Writes a conversation, and its new message. Its room is taken first: what
 * the message adds in the month the conversation is counted in, or the
 * whole conversation in a later one. `refusable` for what someone wrote,
 * which then is not written (DataRoomError); a change of state is always
 * counted, never refused.
 */
async function write(store: Store, statsId: string, handle: string, conversation: Kept, add: Message | null, refusable: boolean, now = Date.now()): Promise<Kept> {
  const [length, oldest] = add ? await redisPipeline([["LLEN", msgKey(statsId, conversation.id)], ["LINDEX", msgKey(statsId, conversation.id), 0]]) : [0, null];
  const dropped = add && Number(length) >= MAX_MESSAGES && typeof oldest === "string" ? dataBytes([oldest], 1) : 0;
  const messages = Math.max(0, (conversation.b ?? 0) + (add ? dataBytes([JSON.stringify(add)], 1) : 0) - dropped);
  const month = monthOf(now + (KEEP + 86_400) * 1000);
  const record = (c: Kept) => dataBytes([JSON.stringify(c)], 3) + (c.token ? dataBytes([c.token, `${statsId}|${c.id}|${handle}`], 1) : 0);
  const next: Kept = { ...conversation, b: messages, bm: month };
  const bytes = conversation.bm === month ? messages - (conversation.b ?? 0) + Math.max(0, record(next) - record(conversation)) : messages + record(next);
  if (bytes > 0) {
    const changes = [{ until: now + (KEEP + 86_400) * 1000, bytes }];
    if (refusable) await needData(store, changes, now);
    else await noteData(store, changes, now);
  }
  conversation = next;
  const commands: (string | number)[][] = [
    ["SET", convKey(statsId, conversation.id), JSON.stringify(conversation), "EX", KEEP],
    ["ZADD", indexKey(statsId), conversation.lastAt, conversation.id],
  ];
  if (add) {
    commands.push(["RPUSH", msgKey(statsId, conversation.id), JSON.stringify(add)]);
    commands.push(["LTRIM", msgKey(statsId, conversation.id), -MAX_MESSAGES, -1]);
  }
  commands.push(["EXPIRE", msgKey(statsId, conversation.id), KEEP]);
  if (conversation.token) commands.push(["SET", tokenKey(conversation.token), `${statsId}|${conversation.id}|${handle}`, "EX", KEEP]);
  await redisPipeline(commands);
  return conversation;
}

async function readKept(statsId: string, id: string): Promise<Kept | null> {
  if (!CONVERSATION_ID.test(id)) return null;
  const [raw] = await redisPipeline([["GET", convKey(statsId, id)]]);
  return parseKept(raw);
}

async function readMessages(statsId: string, id: string): Promise<Message[]> {
  const [raw] = await redisPipeline([["LRANGE", msgKey(statsId, id), 0, -1]]);
  return (Array.isArray(raw) ? raw : []).map(parseMessage).filter((m): m is Message => Boolean(m));
}

/** Keeps the newest MAX_CONVERSATIONS: the older ones' records go with them. */
async function trim(statsId: string): Promise<void> {
  const [over] = await redisPipeline([["ZREVRANGE", indexKey(statsId), MAX_CONVERSATIONS, -1]]);
  const ids = (Array.isArray(over) ? over : []).filter((id): id is string => typeof id === "string" && CONVERSATION_ID.test(id));
  if (!ids.length) return;
  const gone = await Promise.all(ids.map((id) => readKept(statsId, id)));
  await redisPipeline([
    ["ZREM", indexKey(statsId), ...ids],
    ...ids.flatMap((id) => [["DEL", convKey(statsId, id)], ["DEL", msgKey(statsId, id)]]),
    ...gone.filter((c): c is Kept => Boolean(c?.token)).map((c) => ["DEL", tokenKey(c.token)]),
  ]);
}

type NewInput = { store: Store; email: unknown; name: unknown; text: unknown; source: Source; now?: number };

/** A new conversation, its first message and the visitor's token. */
async function open(input: NewInput): Promise<{ ok: true; conversation: Kept; messages: Message[] } | { ok: false; reason: "email" | "short" | "limited" | "closed" }> {
  const { store } = input;
  const statsId = store.statsId;
  if (!statsId || !isRedisConfigured()) return { ok: false, reason: "closed" };
  const email = readEmail(input.email);
  if (!email) return { ok: false, reason: "email" };
  const text = messageText(input.text);
  if (text.length < MIN_MESSAGE) return { ok: false, reason: "short" };
  if (!(await withinLimit("inbox-new", statsId, NEW_PER_DAY, 86_400))) return { ok: false, reason: "limited" };
  const now = input.now ?? Date.now();
  // One of the store's inbox messages for its window (lib/store-allowance-rules.ts), before it is written.
  if (store.period?.funded === true && !(await reservePaidResourceWindow(store))) return { ok: false, reason: "closed" };
  if (!(await takeAllowance(store, "inbox", 1, now)).ok) return { ok: false, reason: "limited" };
  const conversation: Kept = {
    id: newId(),
    email,
    name: nameText(input.name),
    source: input.source,
    status: "open",
    assigned: "",
    startedAt: now,
    lastAt: now,
    lastFrom: "visitor",
    unread: 1,
    token: randomBytes(24).toString("base64url"),
  };
  const message: Message = { at: now, from: "visitor", text };
  const kept = await write(store, statsId, store.handle, conversation, message, true, now);
  await trim(statsId);
  return { ok: true, conversation: kept, messages: [message] };
}

export type VisitorThread = { token: string; status: Conversation["status"]; messages: { at: number; from: Message["from"]; text: string }[] };

const forVisitor = (conversation: Kept, messages: Message[]): VisitorThread => ({
  token: conversation.token,
  status: conversation.status,
  messages: messages.map(({ at, from, text }) => ({ at, from, text })),
});

export type ChatResult = { ok: true; thread: VisitorThread } | { ok: false; reason: "email" | "short" | "limited" | "closed" | "error" | "gone" };

/** A visitor starts a conversation from the chat on the store's pages. The team is told by email. */
export async function startChat(input: { store: Store; email: unknown; name: unknown; text: unknown; ip: string; now?: number }): Promise<ChatResult> {
  const { store } = input;
  if (!chatOpen(store)) return { ok: false, reason: "closed" };
  if (!(await withinLimit("chat-start", `${store.statsId}:${input.ip}`, 5, 3_600))) return { ok: false, reason: "limited" };
  // A store whose data room is full is not taking messages here: said as closed, nothing kept.
  const made = await open({ ...input, source: "chat" }).catch((error) => {
    if (error instanceof DataRoomError) return { ok: false as const, reason: "closed" as const };
    throw error;
  });
  if (!made.ok) return made;
  await tellTeam(store, made.conversation, made.messages[0].text).catch((error) => console.error("telling a store of a chat failed", error));
  return { ok: true, thread: forVisitor(made.conversation, made.messages) };
}

/** A message sent with the store's contact form, filed in the inbox too. Nothing more is sent: the form already emailed the creator. */
export async function fileContact(input: { store: Store; email: string; name: string; text: string; now?: number }): Promise<boolean> {
  if (!input.store.statsId || !isRedisConfigured()) return false;
  const made = await open({ ...input, source: "contact" }).catch((error) => {
    if (error instanceof DataRoomError) return { ok: false as const };
    throw error;
  });
  return made.ok;
}

/**
 * A question the Store assistant hands to the creator (lib/store-assistant.ts):
 * filed as a chat with the address the buyer typed to be answered, and the
 * team told by email, as a chat is. Their answer reaches the buyer by email,
 * and in the store's chat where that is on. Works whether or not the chat is
 * switched on: the inbox is where the creator answers either way.
 */
export async function handOver(input: { store: Store; email: unknown; name: unknown; text: unknown; now?: number }): Promise<ChatResult> {
  const { store } = input;
  if (!store.statsId || !isRedisConfigured() || store.suspended || isHouseStore(store) || !store.email) return { ok: false, reason: "closed" };
  const made = await open({ ...input, source: "chat" }).catch((error) => {
    if (error instanceof DataRoomError) return { ok: false as const, reason: "closed" as const };
    throw error;
  });
  if (!made.ok) return made;
  await tellTeam(store, made.conversation, made.messages[0].text).catch((error) => console.error("telling a store of a handed-over question failed", error));
  return { ok: true, thread: forVisitor(made.conversation, made.messages) };
}

/** "filed" with the conversation that holds the case; otherwise why nothing was filed. */
export type FiledProblem = { state: "filed"; id: string } | { state: "limited" | "full" | "error" };

/**
 * A buyer's report of a problem with an order (567 [GD1] (a), lib/order-problem.ts):
 * filed as an order problem ("order") from the address the order was paid with, and the team
 * told by email, as a chat is. One inbox message from the store's allowance,
 * taken before it is written (open).
 */
export async function fileOrderProblem(input: { store: Store; email: string; text: string; now?: number }): Promise<FiledProblem> {
  const { store } = input;
  if (!store.statsId || !isRedisConfigured()) return { state: "error" };
  const made = await open({ ...input, name: "", source: "order" }).catch((error) => {
    if (error instanceof DataRoomError) return { ok: false as const, reason: "full" as const };
    throw error;
  });
  if (!made.ok) return { state: made.reason === "limited" ? "limited" : made.reason === "full" ? "full" : "error" };
  await tellTeam(store, made.conversation, made.messages[0].text).catch((error) => console.error("telling a store of a problem with an order failed", error));
  return { state: "filed", id: made.conversation.id };
}

async function fromToken(token: unknown): Promise<{ statsId: string; id: string; handle: string } | null> {
  if (typeof token !== "string" || !CHAT_TOKEN.test(token) || !isRedisConfigured()) return null;
  const [raw] = await redisPipeline([["GET", tokenKey(token)]]);
  const [statsId, id, handle] = typeof raw === "string" ? raw.split("|") : [];
  return statsId && id && handle ? { statsId, id, handle } : null;
}

/** The store a visitor's chat token belongs to, by its address, or null. */
export async function tokenHandle(token: unknown): Promise<string | null> {
  return (await fromToken(token))?.handle ?? null;
}

/** What a visitor's chat shows: their conversation's messages, by the token only they hold. */
export async function visitorThread(token: unknown): Promise<VisitorThread | null> {
  const found = await fromToken(token);
  if (!found) return null;
  const [rawConversation, rawMessages] = await redisPipeline([
    ["GET", convKey(found.statsId, found.id)],
    ["LRANGE", msgKey(found.statsId, found.id), 0, -1],
  ]);
  const conversation = parseKept(rawConversation);
  if (!conversation || conversation.token !== token) return null;
  const messages = (Array.isArray(rawMessages) ? rawMessages : []).map(parseMessage).filter((m): m is Message => Boolean(m));
  return forVisitor(conversation, messages);
}

/** A visitor writes again in their conversation; a closed one opens again. */
export async function visitorSend(
  token: unknown,
  textRaw: unknown,
  storeFor: (handle: string) => Promise<Store | null>,
  now = Date.now(),
): Promise<ChatResult> {
  const found = await fromToken(token);
  if (!found) return { ok: false, reason: "gone" };
  const store = await storeFor(found.handle);
  if (!store || store.statsId !== found.statsId) return { ok: false, reason: "gone" };
  if (store.suspended) return { ok: false, reason: "closed" };
  const text = messageText(textRaw);
  if (text.length < MIN_MESSAGE) return { ok: false, reason: "short" };
  const conversation = await readKept(found.statsId, found.id);
  if (!conversation || conversation.token !== token) return { ok: false, reason: "gone" };
  if (!(await withinLimit("chat-send", `${found.statsId}:${found.id}`, VISITOR_PER_HOUR, 3_600))) return { ok: false, reason: "limited" };
  if (store.period?.funded === true && !(await reservePaidResourceWindow(store))) return { ok: false, reason: "closed" };
  if (!(await takeAllowance(store, "inbox", 1, now)).ok) return { ok: false, reason: "limited" };
  const message: Message = { at: now, from: "visitor", text };
  let next: Kept;
  try {
    next = await write(store, found.statsId, store.handle, { ...conversation, status: "open", lastAt: now, lastFrom: "visitor", unread: conversation.unread + 1 }, message, true, now);
  } catch (error) {
    if (error instanceof DataRoomError) return { ok: false, reason: "closed" };
    throw error;
  }
  await tellTeam(store, next, text).catch((error) => console.error("telling a store of a chat failed", error));
  return { ok: true, thread: forVisitor(next, await readMessages(found.statsId, found.id)) };
}

/**
 * Who is told of a buyer's new message (`to`: whoever the conversation is
 * given to, else the owner): the person it was given to only while they still
 * may answer buyers, read again at every send as lib/phone-alerts.ts reads
 * roles: the owner, or someone on the store's team now whose role may see
 * orders (lib/team-roles.ts). A person taken off the team, or moved to a
 * role that does not see orders, is never sent the buyer's words: the owner
 * is told instead, and the conversation goes back to nobody. A team that
 * cannot be read, or reads in an unknown shape (CX-123 rule 24), tells the
 * owner and leaves the conversation as it is.
 */
async function answering(store: Store, id: string, to: string): Promise<string> {
  const given = normaliseEmail(to);
  if (!given || given === normaliseEmail(store.email)) return store.email;
  let members: Member[];
  try {
    members = store.sid ? (await readTeam(store.sid)).members : [];
  } catch (error) {
    console.error("an inbox conversation's team could not be read; the owner is told", error instanceof UnknownReplyError ? error.message : error);
    return store.email;
  }
  const member = members.find((m) => normaliseEmail(m.email) === given);
  if (member && can(member.role, "orders")) return given;
  await giveBack(store, id, to).catch((error) => console.error("giving back a conversation whose person left failed", error));
  return store.email;
}

/**
 * The conversation's record written over only while it is still exactly the text read, its expiry kept: a
 * compare-and-set that never re-creates a record deleted meanwhile (a buyer's erasure, forgetInboxPerson) and
 * never overwrites a change made meanwhile (another assignee). Modelled by lib/redis-memory.ts. 1 written, 0 not.
 */
export const INBOX_GIVE_BACK = `-- marktmorgen:inbox-give-back:v1
if redis.call('GET', KEYS[1]) == ARGV[1] then
  redis.call('SET', KEYS[1], ARGV[2], 'KEEPTTL')
  return 1
end
return 0`;

/**
 * Gives a conversation back to nobody, if it is still given to `stale` when read now. Only the record's
 * `assigned` changes (INBOX_GIVE_BACK): no index entry, chat link or expiry is written, so nothing a buyer's
 * erasure removed in between comes back, and the record only gets smaller, so the data room it was counted
 * in still covers it. A reply in an unknown shape throws UnknownReplyError (rule 24); the caller tells the owner.
 */
async function giveBack(store: Store, id: string, stale: string): Promise<void> {
  if (!store.statsId || !CONVERSATION_ID.test(id)) return;
  const key = convKey(store.statsId, id);
  const [raw] = await redisPipeline([["GET", key]]);
  if (typeof raw !== "string") return;
  const current = parseKept(raw);
  if (!current || current.assigned !== stale) return;
  const swapped = repliesFor(await redisPipeline([["EVAL", INBOX_GIVE_BACK, 1, key, raw, JSON.stringify({ ...current, assigned: "" })]]), 1)?.[0];
  if (swapped !== 0 && swapped !== 1) throw new UnknownReplyError("giving back a conversation whose person left");
}

/** One email to whoever has the conversation (the owner when nobody does), at most every half hour for one conversation. */
async function tellTeam(store: Store, conversation: Kept, text: string): Promise<void> {
  if (!isSenderConfigured() || !store.statsId) return;
  if (!(await withinLimit("inbox-tell", `${store.statsId}:${conversation.id}`, 1, 1_800))) return;
  const to = conversation.assigned || store.email;
  const who = conversation.name || conversation.email;
  const sid = store.sid ? `store=${store.sid}&` : "";
  await sendEmail({ meter: { by: "store", store: store, kind: "email" },
    from: NIMBUS_FROM,
    to: await answering(store, conversation.id, to),
    subject: `New message from ${who.slice(0, 60)} on ${store.name}`.slice(0, 200),
    text: [
      `${who} wrote in ${store.name}'s inbox:`,
      "",
      text.slice(0, 1_000),
      "",
      "Answer it in the studio, so your answer reaches their chat and their email and stays in the conversation:",
      `${SITE_URL}/studio/inbox?${sid}c=${conversation.id}`,
      "",
      "—",
      "You get one of these at most every half hour for each conversation.",
    ].join("\n"),
    idempotencyKey: `inbox-tell-${store.statsId}-${conversation.id}-${conversation.lastAt}`,
  });
}

// ------------------------------------------------------------------ studio

/**
 * The conversation ids of one ZREVRANGE on the index, read exactly (rule 24):
 * a reply that is not one list of strings throws, so it is never taken for an
 * inbox with no conversations.
 */
async function indexIds(statsId: string, last: number): Promise<string[]> {
  const ids = stringList(repliesFor(await redisPipeline([["ZREVRANGE", indexKey(statsId), 0, last]]), 1)?.[0]);
  if (ids === null) throw new UnknownReplyError("the inbox's index");
  return ids.filter((id) => CONVERSATION_ID.test(id));
}

/**
 * The kept conversations of `ids`, one slot for each, read exactly (rule 24):
 * a string is what is kept, null is a conversation that has expired; any
 * other reply, or one of another length, throws, so a conversation is never
 * taken for gone (or for someone else's) on an answer that does not say so.
 */
async function keptSlots(statsId: string, ids: string[]): Promise<(string | null)[]> {
  const slots = repliesFor(repliesFor(await redisPipeline([["MGET", ...ids.map((id) => convKey(statsId, id))]]), 1)?.[0], ids.length);
  if (slots === null || !slots.every((v) => v === null || typeof v === "string")) throw new UnknownReplyError("the inbox's conversations");
  return slots as (string | null)[];
}

/** The store's conversations, open first, then the newest; what has expired is dropped from the index. */
export async function readInbox(statsId: string | null): Promise<Conversation[]> {
  if (!statsId || !isRedisConfigured()) return [];
  const ids = await indexIds(statsId, MAX_CONVERSATIONS - 1);
  if (!ids.length) return [];
  const values = await keptSlots(statsId, ids);
  // Only a slot that answered exactly null has expired; nothing else leaves the index.
  const gone = ids.filter((_, i) => values[i] === null);
  if (gone.length) await redisPipeline([["ZREM", indexKey(statsId), ...gone]]).catch(() => {});
  return inboxOrder(values.map(parseKept).filter((c): c is Kept => Boolean(c)).map(shown));
}

/** How many open conversations have something the store has not read. */
export function unreadCount(list: Conversation[]): number {
  return list.filter((c) => c.status === "open" && c.unread > 0).length;
}

export type Thread = { conversation: Conversation; messages: Message[] };

/** One conversation and its messages, marked as read. */
export async function openConversation(statsId: string, id: string, store?: Store): Promise<Thread | null> {
  const conversation = await readKept(statsId, id);
  if (!conversation) return null;
  if (conversation.unread && store) {
    const next = await write(store, statsId, store.handle, { ...conversation, unread: 0 }, null, false);
    return { conversation: shown(next), messages: await readMessages(statsId, id) };
  }
  return { conversation: shown(conversation), messages: await readMessages(statsId, id) };
}

export type ReplyResult = { ok: true; thread: Thread; emailed: boolean } | { ok: false; reason: "short" | "none" | "limited" };

/** The store answers: the message is kept, shows in the visitor's chat, and is emailed to them in the store's language. */
export async function replyTo(store: Store, id: string, by: string, textRaw: unknown, now = Date.now()): Promise<ReplyResult> {
  const statsId = store.statsId;
  if (!statsId) return { ok: false, reason: "none" };
  const text = messageText(textRaw);
  if (text.length < MIN_MESSAGE) return { ok: false, reason: "short" };
  const conversation = await readKept(statsId, id);
  if (!conversation) return { ok: false, reason: "none" };
  if (!(await withinLimit("inbox-reply", statsId, 400, 86_400))) return { ok: false, reason: "limited" };
  const message: Message = { at: now, from: "store", text, by };
  const next = await write(store, statsId, store.handle, { ...conversation, lastAt: now, lastFrom: "store", unread: 0 }, message, true, now);
  const w = chatWords(store.language);
  const link = chatOpen(store) && next.token ? `${SITE_URL}/@${store.handle}?chat=${next.token}` : "";
  const emailed = isSenderConfigured()
    ? await sendEmail({ meter: { by: "store", store: store, kind: "email" },
        from: storeSender(store),
        to: next.email,
        replyTo: store.email,
        subject: w.replySubject(store.name).slice(0, 200),
        text: [w.replyIntro(store.name), "", text, "", ...(link ? [w.replyLink, link] : [w.replyByEmail]), "", `— ${store.name}`].join("\n"),
        idempotencyKey: `inbox-reply-${statsId}-${id}-${now}`,
      }).catch(() => false)
    : false;
  return { ok: true, thread: { conversation: shown(next), messages: await readMessages(statsId, id) }, emailed };
}

/**
 * First messages a store may write to its affiliates in a day: a bucket of its
 * own under the same counted burst as a visitor's first message ("inbox-new"),
 * so the creator writing to many affiliates never spends the visitors' cap.
 */
const AFFILIATE_MESSAGES_PER_DAY = 50;

export type FirstMessageResult = { ok: true; thread: Thread; emailed: boolean } | { ok: false; reason: "email" | "short" | "limited" | "closed" };

/**
 * The creator writes first, to one of their own affiliates (630 [HN6](5)).
 *
 * A conversation of its own in the store's inbox, marked "affiliate", begun by
 * the store's message rather than a visitor's, so the affiliate's answer and
 * the creator's next reply live where every other conversation does. The
 * affiliate is emailed the message in the store's language, from the store,
 * with replies going to the creator's own address; and, while the store's chat
 * is open, a link back to the conversation, where their answer reaches the
 * inbox. Counted as one of the store's inbox conversations for its window and
 * under a daily cap of its own (AFFILIATE_MESSAGES_PER_DAY), apart from the
 * visitors', before anything is written; refused when the text is too short,
 * the address is not one, or the store is suspended, the house store or has
 * no address of its own for the answers. A store whose data room is full
 * throws DataRoomError, as every write of the inbox does, for the caller to
 * say so; `emailed` false means the conversation is kept but the affiliate
 * was not told (the store's emails spent, or none could be sent), which the
 * caller shows the creator.
 *
 * `to` is an affiliate the caller has read from the store's own program; this
 * function trusts nothing else about them.
 */
export async function writeToAffiliate(
  store: Store,
  to: { email: string; name?: string },
  textRaw: unknown,
  by: string,
  now = Date.now(),
): Promise<FirstMessageResult> {
  const statsId = store.statsId;
  if (!statsId || !isRedisConfigured() || store.suspended || isHouseStore(store) || !store.email) return { ok: false, reason: "closed" };
  const email = readEmail(to.email);
  if (!email) return { ok: false, reason: "email" };
  const text = messageText(textRaw);
  if (text.length < MIN_MESSAGE) return { ok: false, reason: "short" };
  if (!(await withinLimit("inbox-new", `${statsId}:affiliates`, AFFILIATE_MESSAGES_PER_DAY, 86_400))) return { ok: false, reason: "limited" };
  if (store.period?.funded === true && !(await reservePaidResourceWindow(store))) return { ok: false, reason: "closed" };
  if (!(await takeAllowance(store, "inbox", 1, now)).ok) return { ok: false, reason: "limited" };
  const conversation: Kept = {
    id: newId(),
    email,
    name: nameText(to.name ?? ""),
    source: "affiliate",
    status: "open",
    assigned: "",
    startedAt: now,
    lastAt: now,
    lastFrom: "store",
    unread: 0,
    token: randomBytes(24).toString("base64url"),
  };
  const message: Message = { at: now, from: "store", text, by };
  const kept = await write(store, statsId, store.handle, conversation, message, true, now);
  await trim(statsId);
  const w = chatWords(store.language);
  const link = chatOpen(store) && kept.token ? `${SITE_URL}/@${store.handle}?chat=${kept.token}` : "";
  const emailed = isSenderConfigured()
    ? await sendEmail({ meter: { by: "store", store: store, kind: "email" },
        from: storeSender(store),
        to: kept.email,
        replyTo: store.email,
        subject: w.affiliateSubject(store.name).slice(0, 200),
        text: [w.affiliateIntro(store.name), "", text, "", ...(link ? [w.replyLink, link] : [w.replyByEmail]), "", `— ${store.name}`].join("\n"),
        idempotencyKey: `inbox-affiliate-${statsId}-${kept.id}`,
      }).catch(() => false)
    : false;
  return { ok: true, thread: { conversation: shown(kept), messages: [message] }, emailed };
}

/** Closes a conversation, or opens it again. */
export async function setStatus(store: Store, id: string, status: unknown): Promise<Conversation | null> {
  if (!store.statsId || (status !== "open" && status !== "closed")) return null;
  const conversation = await readKept(store.statsId, id);
  if (!conversation) return null;
  const next = await write(store, store.statsId, store.handle, { ...conversation, status, unread: status === "closed" ? 0 : conversation.unread } as Kept, null, false);
  return shown(next);
}

/** Gives a conversation to one of the people who may answer, or to nobody (""). */
export async function assignTo(store: Store, id: string, email: unknown, allowed: string[]): Promise<Conversation | null> {
  if (!store.statsId || typeof email !== "string") return null;
  const who = email ? normaliseEmail(email) : "";
  if (who && !allowed.includes(who)) return null;
  const conversation = await readKept(store.statsId, id);
  if (!conversation) return null;
  const next = await write(store, store.statsId, store.handle, { ...conversation, assigned: who }, null, false);
  return shown(next);
}

/**
 * A suggested answer, for the creator to change before sending (one of the
 * month's jobs). The model is given the store's own questions and answers
 * and the conversation, never the visitor's address or name: addresses,
 * phone numbers and links are taken out of every message first.
 */
export async function suggestReply(store: Store, id: string, now = Date.now()): Promise<AiResult<string>> {
  if (!store.statsId) return { ok: false, reason: "off" };
  const thread = await openConversation(store.statsId, id);
  if (!thread) return { ok: false, reason: "notes" };
  // Written for answering a visitor; a conversation the creator began with an affiliate is not one (630 [HN6](5)).
  if (thread.conversation.source === "affiliate") return { ok: false, reason: "off" };
  const language = LANGUAGES[parseLanguage(store.language)].english;
  return counted(store, now, async () => {
    const faq = store.faq.slice(0, 20).map((f) => `Q: ${forAi(f.q, 300)}\nA: ${forAi(f.a, 800)}`).join("\n\n");
    const transcript = thread.messages
      .slice(-20)
      .map((m) => `${m.from === "visitor" ? "Visitor" : "Store"}: ${forAi(m.text, 1_200)}`)
      .join("\n\n");
    const system = [
      `You draft the next answer from ${store.name}, a creator's online store, to a visitor who wrote to it. The creator reads it and changes it before it is sent.`,
      `Write in ${language}. Plain text, at most 120 words, friendly and direct. No greeting placeholders, no brackets to fill in, no signature.`,
      "Use only what the store's questions and answers and the conversation say. When they do not answer the question, say the creator will check and come back to them. Never promise a refund, a discount, a date or a result they do not state.",
      "Return only the answer.",
    ].join("\n\n");
    const prompt = [faq ? `The store's questions and answers:\n\n${faq}` : "The store has written no questions and answers.", `The conversation, oldest first:\n\n${transcript}`].join("\n\n---\n\n");
    const answer = await askModel(store, system, prompt, 500, answerModel());
    const text = answer ? messageText(answer) : "";
    return text || null;
  });
}

/**
 * Deletes every conversation one person had with the store's inbox
 * (lib/person-erasure.ts): what they wrote, what the store answered, and the
 * link their chat opened with.
 */
export async function forgetInboxPerson(statsId: string | null, email: string): Promise<number> {
  if (!statsId || !isRedisConfigured()) return 0;
  const address = normaliseEmail(email);
  // Every read is exact (rule 24): an unknown index, conversations or deletion answer throws, so the
  // erasure is said as not done and tried again (lib/person-erasure.ts), never answered as finished.
  const ids = await indexIds(statsId, -1);
  const theirs: Kept[] = [];
  // Index entries whose conversation answered exactly null: nothing is kept behind them any more
  // (expired, or deleted by an earlier erasure whose index removal did not finish).
  const gone: string[] = [];
  for (let i = 0; i < ids.length; i += 200) {
    const chunk = ids.slice(i, i + 200);
    const slots = await keptSlots(statsId, chunk);
    slots.forEach((value, at) => {
      if (value === null) gone.push(chunk[at]);
      const kept = parseKept(value);
      if (kept && normaliseEmail(kept.email) === address) theirs.push(kept);
    });
  }
  // Two steps, in this order, so a failure part-way is always found again by the retry (Codex J on #3113):
  // a Redis pipeline is not a transaction, and an index entry removed while its records stayed would leave
  // them kept with nothing pointing to them. First the records, their deletion confirmed; only then the index.
  if (theirs.length) {
    const keys = theirs.flatMap((c) => [convKey(statsId, c.id), msgKey(statsId, c.id), ...(c.token ? [tokenKey(c.token)] : [])]);
    const deleted = countOf(repliesFor(await redisPipeline([["DEL", ...keys]]), 1)?.[0]);
    if (deleted === null || deleted > keys.length) throw new UnknownReplyError("the deletion of a person's conversations");
  }
  const unindex = [...theirs.map((c) => c.id), ...gone];
  if (unindex.length) {
    const removed = countOf(repliesFor(await redisPipeline([["ZREM", indexKey(statsId), ...unindex]]), 1)?.[0]);
    if (removed === null || removed > unindex.length) throw new UnknownReplyError("the removal of a person's conversations from the inbox's index");
  }
  return theirs.length;
}

/** How many conversations the inbox keeps: what deleting a person reads (lib/person-erasure.ts). */
export async function conversationCount(statsId: string | null): Promise<number> {
  if (!statsId || !isRedisConfigured()) return 0;
  const [n] = await redisPipeline([["ZCARD", indexKey(statsId)]]);
  return Math.min(Number(n) || 0, MAX_CONVERSATIONS);
}
