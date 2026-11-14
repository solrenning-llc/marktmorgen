/**
 * R25 finding 1 (synthetic only): a conversation given to a teammate kept
 * `assigned` after that teammate was taken off the team, or moved to a role
 * that may not read orders. Every later message from the buyer was then
 * emailed to that former teammate, with the buyer's name, address and words
 * (lib/inbox.ts tellTeam: `to = conversation.assigned || store.email`).
 *
 * Expected: the team is read again at every send, as lib/phone-alerts.ts
 * does. Only the owner, or a person on the team now whose role may see
 * orders, is told; anybody else is never sent the buyer's words, the owner is
 * told instead and the conversation goes back to nobody. A team read in an
 * unknown shape (CX-123 rule 24) never sends to the assignee: the owner is
 * told and the conversation is left as it is.
 */
import { assignTo, forgetInboxPerson, readInbox, startChat, tokenKey, visitorSend } from "@/lib/inbox";
import { claimHandle, ensureStatsId, setInboxSetting, setSubscription, storeForEmail, storeForHandle } from "@/lib/store";
import { moveMemberships, putMember, readTeam, removeMember, setMemberRole } from "@/lib/team";
import { UnknownReplyError } from "@/lib/redis-reply";
import { can } from "@/lib/team-roles";
import type { Store } from "@/lib/store";
import { advance, store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

process.env.RESEND_API_KEY = "re_test_inbox_only_a_stand_in";

const sent: { to: string; subject: string; text: string }[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status });
  if (url.hostname === "api.resend.com") {
    const body = JSON.parse(String(init?.body)) as { to: string | string[]; subject: string; text: string };
    sent.push({ to: [body.to].flat()[0], subject: body.subject, text: body.text });
    return json({ id: `email_${sent.length}` });
  }
  return json({ object: "list", data: [], has_more: false });
}) as typeof fetch;

const OWNER = "r25-owner@example.com";
const HELPER = "r25-helper@example.com";
const EDITOR = "r25-editor@example.com";
const STAYS = "r25-stays@example.com";
const MOVER = "r25-mover@example.com";
const MOVED = "r25-mover-new@example.com";
const RACER = "r25-racer@example.com";
const SWAPPED = "r25-swapped@example.com";

type Commands = (string | number)[][];
const original = redis.pipeline.bind(redis);

/** Runs work with every GET of `key` answered by `reply`. */
async function withGet<T>(key: string, reply: unknown, work: () => Promise<T>): Promise<T> {
  redis.pipeline = (async (commands: Commands) => {
    const replies = await original(commands);
    return commands.map((c, at) => (c[0] === "GET" && c[1] === key ? reply : replies[at]));
  }) as typeof redis.pipeline;
  try {
    return await work();
  } finally {
    redis.pipeline = original;
  }
}

/**
 * Runs work and, once the team was read for a send and the conversation `conv` read again after it (the give-back's
 * read), runs `between` just before the next Redis call: whatever the give-back writes then lands after it.
 */
async function betweenGiveBack<T>(teamKey: string, conv: string, between: () => Promise<unknown>, work: () => Promise<T>): Promise<{ result: T; ran: boolean }> {
  let teamRead = false;
  let armed = false;
  let ran = false;
  redis.pipeline = (async (commands: Commands) => {
    if (armed && !ran) {
      ran = true;
      redis.pipeline = original;
      try {
        await between();
      } finally {
        redis.pipeline = wrapped;
      }
    }
    const replies = await original(commands);
    if (commands.some((c) => c[0] === "GET" && c[1] === teamKey)) teamRead = true;
    else if (teamRead && !ran && commands.length === 1 && commands[0][0] === "GET" && commands[0][1] === conv) armed = true;
    return replies;
  }) as typeof redis.pipeline;
  const wrapped = redis.pipeline;
  try {
    return { result: await work(), ran };
  } finally {
    redis.pipeline = original;
  }
}

/** Runs work with the give-back script's reply replaced by `reply` (the script itself still runs). */
async function withEval<T>(reply: unknown, work: () => Promise<T>): Promise<T> {
  redis.pipeline = (async (commands: Commands) => {
    const replies = await original(commands);
    return commands.map((c, at) => (c[0] === "EVAL" && String(c[1]).startsWith("-- marktmorgen:inbox-give-back:v1\n") ? reply : replies[at]));
  }) as typeof redis.pipeline;
  try {
    return await work();
  } finally {
    redis.pipeline = original;
  }
}

async function allowedNow(sid: string, ownerEmail: string): Promise<string[]> {
  // The same list app/api/store/inbox/route.ts builds for "assign".
  const team = await readTeam(sid);
  return [ownerEmail, ...team.members.filter((m) => can(m.role, "orders")).map((m) => m.email)];
}

/** A buyer opens a conversation; its token and id. */
async function conversation(store: Store, email: string, name: string, text: string, ip: string): Promise<{ token: string; id: string }> {
  const started = await startChat({ store, email, name, text, ip });
  const token = started.ok ? started.thread.token : "";
  const id = (await readInbox(store.statsId)).find((c) => c.email === email)?.id ?? "";
  return { token, id };
}

/** The buyer writes again half an hour later; the "New message" emails it caused. */
async function writesAgain(token: string, text: string, during?: (work: () => Promise<unknown>) => Promise<unknown>): Promise<{ to: string; subject: string; text: string }[]> {
  advance(31 * 60_000);
  const before = sent.length;
  const work = () => visitorSend(token, text, (h) => storeForHandle(h));
  await (during ? during(work) : work());
  return sent.slice(before).filter((m) => m.subject.startsWith("New message from"));
}

async function assignedOf(store: Store, id: string): Promise<string> {
  return (await readInbox(store.statsId)).find((c) => c.id === id)?.assigned ?? "(missing)";
}

async function main(): Promise<void> {
  redis.clear();
  console.error = () => {};
  await claimHandle(OWNER, "r25inbox", "R25 Inbox", "");
  await ensureStatsId(OWNER);
  await setSubscription(OWNER, { customerId: "cus_R25Inbox001", subscriptionId: "sub_R25Inbox001", active: true, tier: "pro", trialEnds: 0, period: paidPeriod() });
  await setInboxSetting(OWNER, { chat: true, saved: [] });
  let store = (await storeForEmail(OWNER))!;
  is("(setup) the store has a team id", Boolean(store.sid), true);
  is("(setup) three support teammates", [await putMember(store, HELPER, "support"), await putMember(store, EDITOR, "support"), await putMember(store, STAYS, "support")], [true, true, true]);
  const teamKey = `nl:team:${store.sid}`;

  part("Control: given to a teammate who still may answer");
  const c = await conversation(store, "cai.buyer@example.com", "Cai Buyer", "Where is my download link, please?", "10.0.0.3");
  is("(setup) given to the teammate who stays", (await assignTo(store, c.id, STAYS, await allowedNow(store.sid, OWNER)))?.assigned, STAYS);
  const toldC = await writesAgain(c.token, "Second message about the download link.");
  is("the teammate who still may answer is told, and nobody else", toldC.map((m) => m.to), [STAYS]);
  is("the conversation still names that teammate", await assignedOf(store, c.id), STAYS);

  part("Control: given to nobody");
  const n = await conversation(store, "noa.buyer@example.com", "Noa Buyer", "Do you ship to Canada at all?", "10.0.0.4");
  const toldN = await writesAgain(n.token, "Asking again about Canada.");
  is("the owner is told of a conversation given to nobody", toldN.map((m) => m.to), [OWNER]);

  part("A: given to a teammate who is then taken off the team");
  const a = await conversation(store, "ana.buyer@example.com", "Ana Buyer", "My order never arrived, my address is 12 Rua Azul.", "10.0.0.1");
  is("(setup) given to the helper, who may answer now", (await assignTo(store, a.id, HELPER, await allowedNow(store.sid, OWNER)))?.assigned, HELPER);
  is("(setup) the helper is taken off the team", await removeMember(store, HELPER), true);
  store = (await storeForEmail(OWNER))!;
  is("(setup) no longer on the team", (await readTeam(store.sid)).members.some((m) => m.email === HELPER), false);
  const toldA = await writesAgain(a.token, "Second message: my phone is 555 0101 and I want a refund.");
  is("the former teammate gets no email with the buyer's message", toldA.some((m) => m.to === HELPER), false);
  is("the owner is the one told", toldA.map((m) => m.to), [OWNER]);
  is("the conversation no longer names the former teammate", await assignedOf(store, a.id), "");

  part("B: given to a teammate whose role then may not read orders (support -> editor)");
  const b = await conversation(store, "bia.buyer@example.com", "Bia Buyer", "Please send my purchase again.", "10.0.0.2");
  is("(setup) given to the second teammate", (await assignTo(store, b.id, EDITOR, await allowedNow(store.sid, OWNER)))?.assigned, EDITOR);
  is("(setup) moved to editor", (await setMemberRole(store, EDITOR, "editor")).ok, true);
  is("(setup) an editor may not read orders", can("editor", "orders"), false);
  const toldB = await writesAgain(b.token, "Still waiting, here is my card's last digits 4242.");
  is("a teammate who may not read orders gets no buyer message", toldB.some((m) => m.to === EDITOR), false);
  is("the owner is told instead", toldB.map((m) => m.to), [OWNER]);
  is("the conversation no longer names the editor", await assignedOf(store, b.id), "");

  part("Rule 24: the team read in an unknown shape never sends to the assignee");
  const unknown: [string, unknown][] = [
    ["a number", 42],
    ["an object", { members: [] }],
    ["text that is not JSON", "not json"],
    ["JSON without members", JSON.stringify({ invites: [] })],
    ["a JSON array", JSON.stringify([])],
    ["undefined", undefined],
  ];
  const u = await conversation(store, "uma.buyer@example.com", "Uma Buyer", "A question about my order number.", "10.0.0.5");
  is("(setup) given to the teammate who stays", (await assignTo(store, u.id, STAYS, await allowedNow(store.sid, OWNER)))?.assigned, STAYS);
  for (const [label, reply] of unknown) {
    const told = await writesAgain(u.token, `Asking again while the team reads as ${label}.`, (work) => withGet(teamKey, reply, work));
    is(`team read as ${label}: the assignee is not told`, told.some((m) => m.to === STAYS), false);
    is(`team read as ${label}: the owner is told`, told.map((m) => m.to), [OWNER]);
    is(`team read as ${label}: the conversation is left as it is`, await assignedOf(store, u.id), STAYS);
  }
  const toldU = await writesAgain(u.token, "Asking once more with the team read again.");
  is("once the team reads again, the teammate who stays is told", toldU.map((m) => m.to), [STAYS]);

  part("A teammate's sign-in address moved (lib/team.ts moveMemberships) with the conversation still on the old one");
  is("(setup) the teammate who moves is on the team", await putMember(store, MOVER, "support"), true);
  const m = await conversation(store, "mia.buyer@example.com", "Mia Buyer", "Is my invoice ready for order 77?", "10.0.0.7");
  is("(setup) given to the teammate before the move", (await assignTo(store, m.id, MOVER, await allowedNow(store.sid, OWNER)))?.assigned, MOVER);
  await moveMemberships(MOVER, MOVED);
  is("(setup) the team now holds the new address, not the old one", (await readTeam(store.sid)).members.map((x) => x.email).filter((x) => x === MOVER || x === MOVED), [MOVED]);
  const toldM = await writesAgain(m.token, "Asking again about the invoice for order 77.");
  is("the old address gets no email with the buyer's message", toldM.some((x) => x.to === MOVER), false);
  is("the owner is told after the move", toldM.map((x) => x.to), [OWNER]);
  is("the conversation no longer names the old address", await assignedOf(store, m.id), "");

  part("The buyer's erasure lands between the give-back's read and its write");
  is("(setup) the teammate who leaves is on the team", await putMember(store, RACER, "support"), true);
  const r = await conversation(store, "rui.buyer@example.com", "Rui Buyer", "Please delete everything you hold about me.", "10.0.0.8");
  is("(setup) given to that teammate", (await assignTo(store, r.id, RACER, await allowedNow(store.sid, OWNER)))?.assigned, RACER);
  is("(setup) the teammate is taken off the team", await removeMember(store, RACER), true);
  store = (await storeForEmail(OWNER))!;
  const rConv = `nl:inbox:${store.statsId}:c:${r.id}`;
  let erased = -1;
  const before = sent.length;
  const raced = await betweenGiveBack(teamKey, rConv, async () => { erased = await forgetInboxPerson(store.statsId, "rui.buyer@example.com"); }, async () => {
    advance(31 * 60_000);
    return visitorSend(r.token, "One more message before I ask to be erased.", (h) => storeForHandle(h));
  });
  const toldR = sent.slice(before).filter((x) => x.subject.startsWith("New message from"));
  is("(setup) the erasure ran between the give-back's read and its write", [raced.ran, erased], [true, 1]);
  is("the former teammate is not told", toldR.some((x) => x.to === RACER), false);
  is("the owner is told", toldR.map((x) => x.to), [OWNER]);
  is("the erased conversation's record does not come back", (await original([["GET", rConv]]))[0], null);
  is("its entry in the inbox's index does not come back", (await original([["ZSCORE", `nl:inbox:${store.statsId}:all`, r.id]]))[0], null);
  is("its chat link does not come back", (await original([["GET", tokenKey(r.token)]]))[0], null);
  is("the studio's inbox no longer lists the buyer", (await readInbox(store.statsId)).some((x) => x.email === "rui.buyer@example.com"), false);

  part("The owner gives the conversation to someone else between the give-back's read and its write");
  is("(setup) two teammates", [await putMember(store, RACER, "support"), await putMember(store, SWAPPED, "support")], [true, true]);
  const w = await conversation(store, "wen.buyer@example.com", "Wen Buyer", "Who is handling my return?", "10.0.0.9");
  is("(setup) given to the first", (await assignTo(store, w.id, RACER, await allowedNow(store.sid, OWNER)))?.assigned, RACER);
  is("(setup) the first is taken off the team", await removeMember(store, RACER), true);
  store = (await storeForEmail(OWNER))!;
  const wConv = `nl:inbox:${store.statsId}:c:${w.id}`;
  const allowed = await allowedNow(store.sid, OWNER);
  const swapped = await betweenGiveBack(teamKey, wConv, () => assignTo(store, w.id, SWAPPED, allowed), async () => {
    advance(31 * 60_000);
    return visitorSend(w.token, "Asking who handles my return again.", (h) => storeForHandle(h));
  });
  is("(setup) the owner's choice landed between the give-back's read and its write", swapped.ran, true);
  is("the owner's new choice is kept, not cleared by the give-back", await assignedOf(store, w.id), SWAPPED);

  part("Rule 24: the give-back's write answered in an unknown shape");
  const shapes: [string, unknown][] = [["the text \"1\"", "1"], ["null", null], ["an array", [1]], ["undefined", undefined], ["2", 2]];
  for (const [at, [label, reply]] of shapes.entries()) {
    is(`(setup) ${label}: a teammate on the team`, await putMember(store, RACER, "support"), true);
    const g = await conversation(store, `gia.${at}@example.com`, "Gia Buyer", "A question about delivery times.", `10.0.1.${at + 1}`);
    is(`(setup) ${label}: given to that teammate`, (await assignTo(store, g.id, RACER, await allowedNow(store.sid, OWNER)))?.assigned, RACER);
    is(`(setup) ${label}: taken off the team`, await removeMember(store, RACER), true);
    store = (await storeForEmail(OWNER))!;
    const errors: unknown[] = [];
    console.error = (...args: unknown[]) => { errors.push(args[1]); };
    const told = await writesAgain(g.token, `Asking again while the give-back answers ${label}.`, (work) => withEval(reply, work));
    console.error = () => {};
    is(`${label}: the former teammate is not told`, told.some((x) => x.to === RACER), false);
    is(`${label}: the owner is told`, told.map((x) => x.to), [OWNER]);
    is(`${label}: the unknown answer is reported as unknown, never taken as written or not`, errors.some((e) => e instanceof UnknownReplyError), true);
  }

  part("Confirmed empty: the team record is gone (null)");
  const e = await conversation(store, "eli.buyer@example.com", "Eli Buyer", "Can I change my order size?", "10.0.0.6");
  is("(setup) given to the teammate who stays", (await assignTo(store, e.id, STAYS, await allowedNow(store.sid, OWNER)))?.assigned, STAYS);
  await original([["DEL", teamKey]]);
  is("(setup) the team is confirmed empty", (await readTeam(store.sid)).members.length, 0);
  const toldE = await writesAgain(e.token, "Asking again about the size.");
  is("a confirmed empty team: the owner is told, not the old assignee", toldE.map((m) => m.to), [OWNER]);
  is("a confirmed empty team: the conversation goes back to nobody", await assignedOf(store, e.id), "");

  done();
}

void main();
