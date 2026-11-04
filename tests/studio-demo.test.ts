/**
 * 256 [KJ1], unit 2: the studio demo's session door, on the in-memory Redis.
 *
 * Off, the route is a 404 that sends no Redis command. With the switch
 * forced on through the functions' own parameter (STUDIO_DEMO_ON stays false
 * in the code): a program is refused, an address opens five sessions a day,
 * two doors at the day's last place give it to one, every key written is the
 * demo's own with an expiry, the real stores' keys are untouched, a session
 * reads back until it ends, an action is counted at its caps' exact edges
 * and an unknown count refuses. What the door and an action send is held
 * against the costs lib/studio-demo-rules.ts was worked out with.
 */
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { shareAddress } from "@/lib/traffic-rules";
import { DELETE, GET, POST } from "@/app/api/studio-demo/route";
import {
  DEMO_DAY_KEEP_SECONDS, DEMO_TAKE_COMMANDS, STUDIO_DEMO_SEED, STUDIO_DEMO_SEED_BYTES, STUDIO_DEMO_SEED_VALUES,
  answerStudioDemoOpen, openStudioDemo, readStudioDemo, studioDemoCookie, takeDemoAction, type StudioDemoSession,
} from "@/lib/studio-demo";
import {
  DEMO_ACTIONS_PER_SESSION, DEMO_ACTION_MAX_BYTES, DEMO_BYTES_PER_SESSION, DEMO_COMMANDS_PER_ACTION, DEMO_COMMANDS_PER_DAY, DEMO_COOKIE,
  DEMO_KEY_FAMILIES, DEMO_NAMESPACE, DEMO_SESSIONS_PER_ADDRESS_PER_DAY, DEMO_SESSIONS_PER_DAY, DEMO_SESSION_SECONDS,
  DEMO_SESSION_WORST_COMMANDS, DEMO_START_COMMANDS, DEMO_START_DB_BYTES, DEMO_TAKE_DB_BYTES, STUDIO_DEMO_ON, sandboxKey,
} from "@/lib/studio-demo-rules";
import * as rulesNs from "@/lib/studio-demo-rules";
import { store } from "./redis-stub";
import { done, is, part } from "./check";

const chunk = (flat: string[]): [string, string][] => Array.from({ length: Math.floor(flat.length / 2) }, (_, i) => [flat[2 * i], flat[2 * i + 1]]);

// Every command sent, and the bytes each pipeline moves both ways.
const sent: (string | number)[][] = [];
let moved = 0;
const pipeline = store.pipeline;
store.pipeline = async (commands) => {
  sent.push(...commands);
  const replies = await pipeline(commands);
  moved += new TextEncoder().encode(JSON.stringify(commands)).byteLength + new TextEncoder().encode(JSON.stringify(replies)).byteLength;
  return replies;
};
/** What a step sends, as billed: each command, and what a script runs inside. */
async function billed<T>(work: () => Promise<T>): Promise<{ result: T; commands: number; bytes: number; keys: string[] }> {
  const from = sent.length, inner = store.scriptCalls, bytes = moved;
  const result = await work();
  const mine = sent.slice(from);
  const keys = mine.flatMap((c) => (String(c[0]) === "EVAL" ? c.slice(3, 3 + Number(c[2])) : [c[1]]).map(String));
  return { result, commands: mine.length + store.scriptCalls - inner, bytes: moved - bytes, keys };
}

const ON = { on: true, isAutomated: async () => false };
const T0 = Date.UTC(2026, 10, 4, 12, 0, 0, 250);
let clock = T0;
const at = (ms: number) => ({ ...ON, now: () => ms });
const door = (address = "203.0.113.7", headers: Record<string, string> = {}, body?: string) =>
  new Request("https://marktmorgen.com/api/studio-demo", { method: "POST", headers: { "x-forwarded-for": address, ...headers }, body });
const withCookie = (value: string) => new Request("https://marktmorgen.com/api/studio-demo", { headers: { cookie: value } });
const fresh = () => {
  store.clear();
  store.now = () => clock;
};
const dayKey = "nl:sdemo:day:2026-11-04";

async function run(): Promise<void> {
  part("Off: a path that does not exist, and not one Redis command");
  fresh();
  is("STUDIO_DEMO_ON is still false in the code", STUDIO_DEMO_ON, false);
  const offRoute = await billed(async () => [
    (await POST(door())).status,
    (await POST(door("203.0.113.7", { origin: "https://elsewhere.example", "content-type": "application/json" }, JSON.stringify({ website: "x".repeat(5_000) })))).status,
    (await GET()).status,
    (await DELETE()).status,
  ]);
  is("POST, GET and DELETE answer 404", offRoute.result, [404, 404, 404, 404]);
  is("the body is not read and nothing is answered in it", await (await POST(door())).text(), "");
  const offLib = await billed(async () => [
    (await openStudioDemo(door())).ok,
    (await answerStudioDemoOpen(door())).status,
    (await takeDemoAction({ id: "sd" + "a".repeat(32), day: "2026-11-04", startedAt: T0, expiresAt: T0 + 1, actions: 0, bytes: 0 }, { commands: 12, bytes: 1 })).ok,
  ]);
  is("off, the functions refuse too", offLib.result, [false, 404, false]);
  is("zero Redis commands while off", offRoute.commands + offLib.commands, 0);
  is("no key in Redis", store.keys(), []);

  part("A program is refused before anything is counted or written");
  fresh();
  const bot = await billed(() => openStudioDemo(door(), { on: true, isAutomated: async () => true, now: () => clock }));
  // The stand-in keeps an empty hash for a key HGET asked about; Redis does not, so a field count is what tells a write.
  is("after the day's refusals read alone (one command), nothing is counted or written", [bot.commands, store.keys().filter((k) => k !== dayKey), store.run(["HLEN", dayKey])], [1, [], 0]);
  is("the bot check's verdict refuses", bot.result, { ok: false, reason: "automated" });
  const honeypot = await billed(() => answerStudioDemoOpen(door("203.0.113.7", { "content-type": "application/json" }, JSON.stringify({ website: "https://spam.example" })), at(clock)));
  is("the hidden field filled reads as a program, with no command", [honeypot.result.status, honeypot.commands], [403, 0]);
  is("another site is refused", (await answerStudioDemoOpen(door("203.0.113.7", { origin: "https://elsewhere.example", host: "marktmorgen.com" }), at(clock))).status, 403);
  is("a body past its bound is refused", (await answerStudioDemoOpen(door("203.0.113.7", {}, "{" + " ".repeat(300) + "}"), at(clock))).status, 413);
  is("a body that is not an object is refused", (await answerStudioDemoOpen(door("203.0.113.7", {}, "[]"), at(clock))).status, 400);

  part("Sessions an address a day; the new kind of address by its network");
  fresh();
  is("three at the most an address", DEMO_SESSIONS_PER_ADDRESS_PER_DAY <= 3, true);
  const mine: boolean[] = [];
  for (let i = 0; i < DEMO_SESSIONS_PER_ADDRESS_PER_DAY; i += 1) mine.push((await openStudioDemo(door("198.51.100.1"), at(clock))).ok);
  is("an address opens its own", mine, mine.map(() => true));
  is("the next is refused", await openStudioDemo(door("198.51.100.1"), at(clock)), { ok: false, reason: "address" });
  is("another address still opens", (await openStudioDemo(door("198.51.100.2"), at(clock))).ok, true);
  const network: boolean[] = [];
  for (let i = 0; i < DEMO_SESSIONS_PER_ADDRESS_PER_DAY; i += 1) network.push((await openStudioDemo(door(`2001:db8:abcd:${i + 1}::${i + 7}`), at(clock))).ok);
  is("addresses of one network, each on its own /64, open the network's own", network, network.map(() => true));
  is("the network's next, from yet another /64, is refused", await openStudioDemo(door("2001:db8:abcd:ff::1"), at(clock)), { ok: false, reason: "address" });
  is("another network still opens", (await openStudioDemo(door("2001:db8:abce::1"), at(clock))).ok, true);
  is("no address or network is kept in the clear", store.keys().some((k) => /198\.51\.100|2001:db8/.test(k)) || JSON.stringify(store.run(["HGETALL", `${DEMO_NAMESPACE}addr:2026-11-04`])).includes("db8"), false);
  is("the addresses' counts end with the day", store.run(["PEXPIRETIME", `${DEMO_NAMESPACE}addr:2026-11-04`]), Date.UTC(2026, 10, 5));
  {
    // An address's field is made with the deployment's key: a plain hash of an
    // IPv4 address can be found again by trying all 2^32 of them.
    const plain = createHash("sha256").update(`marktmorgen-studio-demo:${shareAddress("198.51.100.1")}`).digest("hex").slice(0, 32);
    const fields = Object.keys(Object.fromEntries(chunk(store.run(["HGETALL", `${DEMO_NAMESPACE}addr:2026-11-04`]) as string[])));
    is("an address is counted under a keyed fingerprint, never a plain hash anyone can recompute", [fields.length > 0, fields.includes(plain)], [true, false]);
  }

  part("The day's last place, taken by one of two doors");
  fresh();
  store.run(["HSET", dayKey, "sessions", String(DEMO_SESSIONS_PER_DAY - 1), "commands", "0", "sent", "0"]);
  const both = await Promise.all([openStudioDemo(door("192.0.2.1"), at(clock)), openStudioDemo(door("192.0.2.2"), at(clock))]);
  is("one opens, the other is refused for the day's sessions", both.map((o) => (o.ok ? "ok" : o.reason)).sort(), ["ok", "sessions"]);
  is("the day counts exactly its cap", store.run(["HGET", dayKey, "sessions"]), String(DEMO_SESSIONS_PER_DAY));
  fresh();
  store.run(["HSET", dayKey, "sessions", "0", "commands", String(DEMO_COMMANDS_PER_DAY - DEMO_SESSION_WORST_COMMANDS), "sent", "0"]);
  const room = await Promise.all([openStudioDemo(door("192.0.2.1"), at(clock)), openStudioDemo(door("192.0.2.2"), at(clock))]);
  is("room for one session's whole worst: one opens, the other is refused for the day's commands", room.map((o) => (o.ok ? "ok" : o.reason)).sort(), ["commands", "ok"]);
  is("the reservation fills the day's commands exactly", store.run(["HGET", dayKey, "commands"]), String(DEMO_COMMANDS_PER_DAY));
  fresh();
  store.run(["HSET", dayKey, "sessions", "abc"]);
  is("a day's count that is not a number refuses", await openStudioDemo(door(), at(clock)), { ok: false, reason: "unknown" });
  fresh();
  const realPipeline = store.pipeline;
  store.pipeline = async (commands) => (String(commands[0][0]) === "EVAL" ? Promise.reject(new Error("down")) : realPipeline(commands));
  is("today's counts out of reach refuse", await openStudioDemo(door(), at(clock)), { ok: false, reason: "unknown" });
  store.pipeline = realPipeline;

  part("What opening writes: the demo's own keys, each ending");
  fresh();
  const house: [string, string][] = [
    ["nl:store:0123456789abcdef0123456789abcdef", JSON.stringify({ name: "Harbor Kitchen", handle: "harborkitchen" })],
    ["nl:handle:harborkitchen", "0123456789abcdef0123456789abcdef"],
    ["nl:house:seed", JSON.stringify({ fingerprint: "f", missing: [] })],
    ["nl:session:abc", "owner@example.test"],
  ];
  for (const [k, v] of house) store.run(["SET", k, v]);
  const before = house.map(([k]) => [k, store.run(["GET", k]), store.run(["PTTL", k])]);
  const opened = await billed(() => openStudioDemo(door(), at(clock)));
  if (!opened.result.ok) throw new Error(`the door did not open: ${opened.result.reason}`);
  const session = opened.result.session;
  is("the session id is sd and 32 hex digits", /^sd[0-9a-f]{32}$/.test(session.id), true);
  is("two sessions never share an id", new Set(await Promise.all([1, 2, 3].map(async (i) => {
    const o = await openStudioDemo(door(`192.0.2.${10 + i}`), at(clock));
    return o.ok ? o.session.id : "";
  }))).size, 3);
  const after = house.map(([k]) => [k, store.run(["GET", k]), store.run(["PTTL", k])]);
  is("the real stores' keys are untouched", after, before);
  const touched = opened.keys;
  is("every key the door sends is in the demo's namespace", touched.every((k) => k.startsWith(DEMO_NAMESPACE)), true);
  const sandbox = touched.filter((k) => k !== dayKey && k !== `${DEMO_NAMESPACE}addr:2026-11-04`);
  const families = sandbox.map((k) => k.slice(`${DEMO_NAMESPACE}{${session.id}}:`.length));
  is("its sandbox keys are the session record and the five first drafts", families, ["session", "product", "page", "offer", "subscription", "email"]);
  is("every one is made by sandboxKey, in an allowed family", sandbox.every((k, i) => sandboxKey(session.id, families[i]) === k && DEMO_KEY_FAMILIES.includes(families[i])), true);
  const written = store.keys().filter((k) => !house.some(([h]) => h === k));
  is("every key written has an expiry", written.filter((k) => Number(store.run(["PTTL", k])) <= 0), []);
  is("every key written is the demo's", written.filter((k) => !k.startsWith(DEMO_NAMESPACE)), []);
  is("the sandbox's keys all end when the session does, at the same instant", [...new Set(sandbox.map((k) => store.run(["PEXPIRETIME", k])))], [session.expiresAt]);
  is("the session lives its 30 minutes from its whole second", [session.startedAt, session.expiresAt - session.startedAt], [Math.floor(T0 / 1000) * 1000, DEMO_SESSION_SECONDS * 1000]);
  is("the day's counts are kept 400 days", store.run(["TTL", dayKey]), DEMO_DAY_KEEP_SECONDS);
  is("the day reserved the session's whole worst", [store.run(["HGET", dayKey, "commands"]), store.run(["HGET", dayKey, "sent"])], [String(4 * DEMO_SESSION_WORST_COMMANDS), String(4 * DEMO_START_COMMANDS)]);
  is("the first drafts are the fixed fictional ones", sandbox.slice(1).map((k) => store.run(["GET", k])), STUDIO_DEMO_SEED_VALUES);
  is("the record counts the first drafts' bytes", store.run(["HGET", sandbox[0], "bytes"]), String(STUDIO_DEMO_SEED_BYTES));
  is("opening bills exactly DEMO_START_COMMANDS", opened.commands, DEMO_START_COMMANDS);
  is(`and moves no more than DEMO_START_DB_BYTES (${opened.bytes})`, opened.bytes <= DEMO_START_DB_BYTES, true);

  part("The cookie");
  const cookie = opened.result.cookie;
  is("its own name, HttpOnly, Secure, SameSite=Lax", cookie.split("; ").filter((p) => /^(HttpOnly|Secure|SameSite=Lax|Path=\/)$/.test(p)).sort(), ["HttpOnly", "Path=/", "SameSite=Lax", "Secure"]);
  is("named nl_studio_demo with the session's id", cookie.startsWith(`${DEMO_COOKIE}=${session.id};`), true);
  is("kept no longer than the session lives", cookie.includes(`Max-Age=${Math.floor((session.expiresAt - T0) / 1000)};`), true);
  is("ten minutes on, it says what is left", studioDemoCookie(session, session.startedAt + 600_000).includes(`Max-Age=${DEMO_SESSION_SECONDS - 600};`), true);
  const answered = await answerStudioDemoOpen(door("192.0.2.99"), at(clock));
  is("the door's answer carries it, never cached", [answered.status, (answered.headers.get("set-cookie") ?? "").startsWith(`${DEMO_COOKIE}=sd`), answered.headers.get("cache-control")], [200, true, "no-store"]);

  part("Reading a session");
  const cookieHeader = `${DEMO_COOKIE}=${session.id}`;
  is("the cookie reads its live session", await readStudioDemo(withCookie(`nl_session=x; ${cookieHeader}`), { now: () => clock }), session);
  is("no cookie, no session", await readStudioDemo(withCookie("nl_session=x"), { now: () => clock }), null);
  is("a malformed id reads nothing and sends nothing", (await billed(() => readStudioDemo(withCookie(`${DEMO_COOKIE}=0123456789abcdef0123456789abcdef`), { now: () => clock }))).commands, 0);
  is("an unknown id, null", await readStudioDemo(withCookie(`${DEMO_COOKIE}=sd${"f".repeat(32)}`), { now: () => clock }), null);
  is("the cookie given twice, null", await readStudioDemo(withCookie(`${cookieHeader}; ${cookieHeader}`), { now: () => clock }), null);
  is("its last millisecond, live", (await readStudioDemo(withCookie(cookieHeader), { now: () => session.expiresAt - 1 }))?.id, session.id);
  is("at its end, null", await readStudioDemo(withCookie(cookieHeader), { now: () => session.expiresAt }), null);
  store.run(["HSET", sandbox[0], "bytes", "lots"]);
  is("a record that does not read as written, null", await readStudioDemo(withCookie(cookieHeader), { now: () => clock }), null);
  store.run(["HSET", sandbox[0], "bytes", String(STUDIO_DEMO_SEED_BYTES)]);
  clock = session.expiresAt;
  is("expired in Redis too: the record is gone", [store.run(["EXISTS", sandbox[0]]), await readStudioDemo(withCookie(cookieHeader), { now: () => clock })], [0, null]);
  clock = T0;

  part("An action: checked and counted at its caps' exact edges");
  fresh();
  const o = await openStudioDemo(door(), at(clock));
  if (!o.ok) throw new Error("no session");
  const s: StudioDemoSession = o.session;
  const record = sandboxKey(s.id, "session")!;
  const cost = { commands: DEMO_COMMANDS_PER_ACTION, bytes: 100 };
  const first = await billed(() => takeDemoAction(s, cost, at(clock)));
  is("the first action is counted", first.result, { ok: true, actions: 1, bytes: STUDIO_DEMO_SEED_BYTES + 100 });
  is("its check and count bill DEMO_TAKE_COMMANDS", first.commands, DEMO_TAKE_COMMANDS);
  is("under an action's commands", DEMO_TAKE_COMMANDS < DEMO_COMMANDS_PER_ACTION, true);
  is(`and move no more than DEMO_TAKE_DB_BYTES (${first.bytes})`, first.bytes <= DEMO_TAKE_DB_BYTES, true);
  is("and touch only the day (its refusals read first) and the session record", [...new Set(first.keys)], [dayKey, record]);
  is("the day counts the commands sent", store.run(["HGET", dayKey, "sent"]), String(DEMO_START_COMMANDS + DEMO_COMMANDS_PER_ACTION));
  store.run(["HSET", record, "actions", String(DEMO_ACTIONS_PER_SESSION - 1)]);
  is("the last action runs", (await takeDemoAction(s, cost, at(clock))).ok, true);
  is("one past it is refused", await takeDemoAction(s, cost, at(clock)), { ok: false, reason: "actions" });
  store.run(["HSET", record, "actions", String(DEMO_ACTIONS_PER_SESSION - 1)]);
  const race = await Promise.all([takeDemoAction(s, cost, at(clock)), takeDemoAction(s, cost, at(clock))]);
  is("two actions at the last place: one runs, one is refused", race.map((r) => (r.ok ? "ok" : r.reason)).sort(), ["actions", "ok"]);
  store.run(["HSET", record, "actions", "0", "bytes", String(DEMO_BYTES_PER_SESSION - 100)]);
  is("filling the session's bytes exactly runs", (await takeDemoAction(s, cost, at(clock))).ok, true);
  is("one byte past them is refused", await takeDemoAction(s, { commands: DEMO_TAKE_COMMANDS, bytes: 1 }, at(clock)), { ok: false, reason: "bytes" });
  store.run(["HSET", record, "bytes", "0"]);
  is("an action dearer than the worst costed is refused", [
    await takeDemoAction(s, { commands: DEMO_COMMANDS_PER_ACTION + 1, bytes: 0 }, at(clock)),
    await takeDemoAction(s, { commands: DEMO_TAKE_COMMANDS, bytes: DEMO_ACTION_MAX_BYTES + 1 }, at(clock)),
  ], [{ ok: false, reason: "too_big" }, { ok: false, reason: "too_big" }]);
  is("its last millisecond runs", (await takeDemoAction(s, cost, at(s.expiresAt - 1))).ok, true);
  is("at its end it is over", await takeDemoAction(s, cost, at(s.expiresAt)), { ok: false, reason: "expired" });
  store.run(["HSET", dayKey, "sent", String(DEMO_COMMANDS_PER_DAY - DEMO_COMMANDS_PER_ACTION + 1)]);
  is("one command past the day's is refused", await takeDemoAction(s, cost, at(clock)), { ok: false, reason: "commands" });
  store.run(["HDEL", dayKey, "sent"]);
  is("the day's count missing refuses", await takeDemoAction(s, cost, at(clock)), { ok: false, reason: "unknown" });
  store.run(["HSET", dayKey, "sent", "0"]);

  part("Unknown counts refuse, before any command");
  const unknown = await billed(async () => [
    await takeDemoAction(s, { commands: Number.NaN, bytes: 0 }, at(clock)),
    await takeDemoAction(s, { commands: -1, bytes: 0 }, at(clock)),
    await takeDemoAction(s, { commands: 12, bytes: Number.POSITIVE_INFINITY }, at(clock)),
    await takeDemoAction(s, { commands: 12, bytes: 1.5 }, at(clock)),
    await takeDemoAction(s, { commands: DEMO_TAKE_COMMANDS - 1, bytes: 0 }, at(clock)),
    await takeDemoAction({ ...s, id: "0123456789abcdef0123456789abcdef" }, cost, at(clock)),
    await takeDemoAction(s, cost, at(Number.NaN)),
  ]);
  is("each refuses as unknown", unknown.result.map((r) => (r.ok ? "ok" : r.reason)), Array(7).fill("unknown"));
  const sentBefore = store.run(["HGET", dayKey, "sent"]);
  is("the day is the record's, never the caller's", (await takeDemoAction({ ...s, day: "2026-01-01" }, cost, at(clock))).ok, true);
  is("so the opening day counts it", [Number(store.run(["HGET", dayKey, "sent"])) - Number(sentBefore), store.run(["EXISTS", "nl:sdemo:day:2026-01-01"])], [DEMO_COMMANDS_PER_ACTION, 0]);
  is("and sends nothing", unknown.commands, 0);
  store.run(["HSET", record, "actions", "x"]);
  is("a record that does not read as written refuses", await takeDemoAction(s, cost, at(clock)), { ok: false, reason: "unknown" });
  store.run(["DEL", record]);
  is("a session whose record is gone is over", await takeDemoAction(s, cost, at(clock)), { ok: false, reason: "expired" });

  part("Refusals: each counted, the day's capped, and past the cap one command each");
  fresh();
  const RN = rulesNs as unknown as Record<string, unknown>;
  const REFUSALS = Number(RN.DEMO_REFUSALS_PER_DAY), REFUSAL_WORST = Number(RN.DEMO_REFUSAL_WORST_COMMANDS);
  is("the day's refusals and a refusal's commands are capped", [Number.isSafeInteger(REFUSALS) && REFUSALS > 0, Number.isSafeInteger(REFUSAL_WORST) && REFUSAL_WORST > 0], [true, true]);
  const live = await openStudioDemo(door("192.0.2.50"), at(clock));
  if (!live.ok) throw new Error("no session");
  const liveRecord = sandboxKey(live.session.id, "session")!;
  for (let i = 0; i < DEMO_SESSIONS_PER_ADDRESS_PER_DAY; i += 1) await openStudioDemo(door("192.0.2.60"), at(clock));
  const refusedNow = () => Number(store.run(["HGET", dayKey, "refused"]) ?? 0);
  const ghost: StudioDemoSession = { ...live.session, id: "sd" + "e".repeat(32) };
  const paths: [string, () => Promise<unknown>, () => void][] = [
    ["an address past its sessions", () => openStudioDemo(door("192.0.2.60"), at(clock)), () => {}],
    ["a day with no session left", () => openStudioDemo(door("192.0.2.61"), at(clock)), () => store.run(["HSET", dayKey, "sessions", String(DEMO_SESSIONS_PER_DAY)])],
    ["a session whose record is gone", () => takeDemoAction(ghost, { commands: DEMO_COMMANDS_PER_ACTION, bytes: 1 }, at(clock)), () => {}],
    ["an action past the day's commands", () => takeDemoAction(live.session, { commands: DEMO_COMMANDS_PER_ACTION, bytes: 1 }, at(clock)), () => store.run(["HSET", dayKey, "sent", String(DEMO_COMMANDS_PER_DAY)])],
    ["an action past the session's, refused by its script", () => takeDemoAction(live.session, { commands: DEMO_COMMANDS_PER_ACTION, bytes: 1 }, at(clock)), () => {
      store.run(["HSET", dayKey, "sent", "0"]);
      // As if another request took the last place between this one's read and its count.
      const run = store.run.bind(store);
      store.run = (command) => {
        if (String(command[0]) === "EVAL") {
          store.run = run;
          run(["HSET", liveRecord, "actions", String(DEMO_ACTIONS_PER_SESSION)]);
        }
        return run(command);
      };
    }],
    ["a cookie naming no session", () => readStudioDemo(withCookie(`${DEMO_COOKIE}=${ghost.id}`), { now: () => clock }), () => {}],
  ];
  for (const [name, work, setUp] of paths) {
    setUp();
    const was = refusedNow();
    const step = await billed(work);
    const result = step.result as { ok?: boolean } | null;
    is(`${name}: refused, counted once, in ${step.commands} commands at most DEMO_REFUSAL_WORST_COMMANDS`, [result === null || result.ok === false, refusedNow() - was, step.commands <= REFUSAL_WORST], [true, 1, true]);
  }
  store.run(["HSET", dayKey, "sessions", "0", "refused", String(REFUSALS)]);
  const shut = () => store.keys().map((k) => [k, store.run(["TYPE", k]) === "hash" ? store.run(["HGETALL", k]) : store.run(["GET", k])]);
  const beforeShut = shut();
  const closedOpen = await billed(() => openStudioDemo(door("192.0.2.70"), at(clock)));
  const closedTake = await billed(() => takeDemoAction(live.session, { commands: DEMO_COMMANDS_PER_ACTION, bytes: 1 }, at(clock)));
  const closedRead = await billed(() => readStudioDemo(withCookie(`${DEMO_COOKIE}=${live.session.id}`), { now: () => clock }));
  is("past the day's refusals, a door, an action and a read are each answered after one command", [closedOpen.result, closedTake.result, closedRead.result, closedOpen.commands, closedTake.commands, closedRead.commands], [{ ok: false, reason: "closed" }, { ok: false, reason: "closed" }, null, 1, 1, 1]);
  is("and nothing is written", shut(), beforeShut);

  part("Its first drafts, and what the module may reach");
  const seedFile = readFileSync("lib/demo-seed.ts", "utf8");
  is("the product, the page and the offer are the demo store's own words", [
    STUDIO_DEMO_SEED.product.title, STUDIO_DEMO_SEED.product.summary, STUDIO_DEMO_SEED.page.blocks[0].headline, STUDIO_DEMO_SEED.page.blocks[0].sub, STUDIO_DEMO_SEED.offer.product,
  ].map((words) => seedFile.includes(`"${words}"`)), [true, true, true, true, true]);
  is("their prices are the demo store's", [seedFile.includes('price: "27"'), seedFile.includes('{ label: "5 weeks", price: "39"'), seedFile.includes('price: "5",')], [true, true, true]);
  is("the first drafts are far under a session's bytes", STUDIO_DEMO_SEED_BYTES < DEMO_ACTION_MAX_BYTES, true);
  const source = readFileSync("lib/studio-demo.ts", "utf8");
  const imports = [...source.matchAll(/^import[^;]*?from "([^"]+)";/gm)].map((m) => m[1]).sort();
  is("it imports only the bot check, Redis, the request guard, its rules, the address rule and the key its fingerprints are made with", imports, ["@/lib/bot-check", "@/lib/redis", "@/lib/request-guard", "@/lib/secret-box", "@/lib/studio-demo-rules", "@/lib/traffic-rules", "node:crypto"]);
  is("the route imports only the module", [...readFileSync("app/api/studio-demo/route.ts", "utf8").matchAll(/from "([^"]+)"/g)].map((m) => m[1]), ["@/lib/studio-demo"]);
  is("no switch is read from the environment", /process\.env/.test(source), false);
}

run().then(done, (error) => {
  console.error(error);
  process.exit(1);
});
