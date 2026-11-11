/**
 * 611 [WP10], unit 2: a buyer's request to move their purchases to another
 * address, kept. One link for each address, both ending with the request a
 * day later; each confirmation kept on its own so two at once are both
 * counted; the move claimed once, never twice; at most three requests an
 * address a day, counted under a one-way fingerprint. No route, page or
 * email yet: those are the next unit.
 */
import {
  MOVE_TOKEN,
  askPurchaseMove,
  claimPurchaseMove,
  confirmPurchaseMove,
  readPurchaseMove,
} from "@/lib/purchase-moves";
import { MAX_MOVES_PER_ADDRESS_DAY, MOVE_CONFIRM_SECONDS } from "@/lib/purchase-move-rules";
import { MOVE_MARK_SECONDS } from "@/lib/purchase-moves";
import { PERSON_DATA } from "@/lib/person-data";
import { store as redis, advance } from "./redis-stub";
import { done, is, part } from "./check";

const SID = "0123456789abcdef0123456789abcdef";

/** Answers `reply` to one command on keys starting with `prefix`, as a database that answered something else would. */
function answer(command: string, prefix: string, reply: unknown): () => void {
  const run = redis.run.bind(redis);
  redis.run = (c: (string | number)[]) => (String(c[0]).toUpperCase() === command && String(c[1]).startsWith(prefix) ? reply : run(c));
  return () => {
    redis.run = run;
  };
}

async function main(): Promise<void> {
  redis.clear();
  const t0 = Date.now();

  part("Asking");
  is("not an address", await askPurchaseMove({ from: "old@example.com", to: "nope", scope: "all", now: t0 }), { ok: false, reason: "email" });
  is("the same address", await askPurchaseMove({ from: "old@example.com", to: " OLD@example.com", scope: "all", now: t0 }), { ok: false, reason: "same" });
  is("a scope that is neither a store nor all", await askPurchaseMove({ from: "old@example.com", to: "new@example.com", scope: "everything", now: t0 }), { ok: false, reason: "scope" });
  const asked = await askPurchaseMove({ from: "Old@Example.com", to: "new@example.com", scope: SID, now: t0 });
  if (!asked.ok) throw new Error(`not asked: ${asked.reason}`);
  is("two links, each its own", [MOVE_TOKEN.test(asked.fromToken), MOVE_TOKEN.test(asked.toToken), asked.fromToken !== asked.toToken], [true, true, true]);
  const keys = redis.keys().filter((k) => k.startsWith("nl:pm:"));
  const ttls = keys.map((k) => redis.run(["TTL", k]) as number);
  is("every key ends by itself, within two days", ttls.every((t) => t > 0 && t <= 2 * 86_400), true);
  is("the request and its links end with the day allowed", keys.filter((k) => !k.startsWith("nl:pm:day:")).every((k) => (redis.run(["TTL", k]) as number) <= MOVE_CONFIRM_SECONDS), true);
  const everything = keys.map((k) => `${k} ${JSON.stringify(redis.run(["TYPE", k]) === "string" ? redis.run(["GET", k]) : "")}`).join("\n");
  is("the links' secrets are kept nowhere, only their fingerprints", [everything.includes(asked.fromToken), everything.includes(asked.toToken)], [false, false]);
  is("the day's count names no address", keys.filter((k) => k.startsWith("nl:pm:day:")).some((k) => k.includes("@") || k.includes("old")), false);
  is("the request reads back, normalised, waiting for both", await readPurchaseMove(asked.id), {
    from: "old@example.com",
    to: "new@example.com",
    scope: { kind: "store", sid: SID },
    createdAt: Math.floor(t0 / 1000),
    fromConfirmedAt: null,
    toConfirmedAt: null,
    appliedAt: null,
  });

  part("Nothing moves without both");
  is("claimed before any confirmation", await claimPurchaseMove(asked.id, t0 + 1_000), { ok: false, reason: "not-ready" });
  is("a made-up link", await confirmPurchaseMove("0".repeat(48), t0 + 1_000), { ok: false, reason: "link" });
  is("not a link at all", await confirmPurchaseMove("../../etc", t0 + 1_000), { ok: false, reason: "link" });
  is("the old address confirms", await confirmPurchaseMove(asked.fromToken, t0 + 2_000), { ok: true, id: asked.id, side: "from", state: "waiting-to" });
  is("again: nothing changes", await confirmPurchaseMove(asked.fromToken, t0 + 3_000), { ok: true, id: asked.id, side: "from", state: "waiting-to" });
  is("its time is the first press", (await readPurchaseMove(asked.id))?.fromConfirmedAt, Math.floor((t0 + 2_000) / 1000));
  is("still not claimed", await claimPurchaseMove(asked.id, t0 + 3_000), { ok: false, reason: "not-ready" });
  is("the new address confirms", await confirmPurchaseMove(asked.toToken, t0 + 4_000), { ok: true, id: asked.id, side: "to", state: "ready" });

  part("Moved once, never twice");
  const claimed = await claimPurchaseMove(asked.id, t0 + 5_000);
  is("claimed", [claimed.ok, claimed.ok && claimed.request.appliedAt], [true, Math.floor((t0 + 5_000) / 1000)]);
  is("a second claim is refused", await claimPurchaseMove(asked.id, t0 + 6_000), { ok: false, reason: "done" });
  is("and a link pressed after it changes nothing", await confirmPurchaseMove(asked.toToken, t0 + 6_000), { ok: false, reason: "done" });

  part("Two confirmations at the same moment are both kept");
  const both = await askPurchaseMove({ from: "a@example.com", to: "b@example.com", scope: "all", now: t0 });
  if (!both.ok) throw new Error("not asked");
  await Promise.all([confirmPurchaseMove(both.fromToken, t0 + 1_000), confirmPurchaseMove(both.toToken, t0 + 1_000)]);
  is("ready", (await claimPurchaseMove(both.id, t0 + 2_000)).ok, true);
  const twice = await Promise.all([claimPurchaseMove(both.id, t0 + 3_000), claimPurchaseMove(both.id, t0 + 3_000)]);
  is("two claims at once: neither moves it again", twice.map((c) => c.ok), [false, false]);

  const race = await askPurchaseMove({ from: "r1@example.com", to: "r2@example.com", scope: "all", now: t0 });
  if (!race.ok) throw new Error("not asked");
  await confirmPurchaseMove(race.fromToken, t0 + 1_000);
  await confirmPurchaseMove(race.toToken, t0 + 1_000);
  const racing = await Promise.all([claimPurchaseMove(race.id, t0 + 2_000), claimPurchaseMove(race.id, t0 + 2_000)]);
  is("two claims racing on a ready request: exactly one moves it, the other is told it is done", racing.map((c) => (c.ok ? "ok" : c.reason)).sort(), ["done", "ok"]);

  part("A request not finished in time");
  const late = await askPurchaseMove({ from: "c@example.com", to: "d@example.com", scope: "all", now: t0 });
  if (!late.ok) throw new Error("not asked");
  await confirmPurchaseMove(late.fromToken, t0 + 1_000);
  is("past its day, a link still kept is refused", await confirmPurchaseMove(late.toToken, t0 + MOVE_CONFIRM_SECONDS * 1000), { ok: false, reason: "expired" });
  advance(MOVE_CONFIRM_SECONDS * 1000 + 1_000);
  is("and once its keys ended, the link is gone", await confirmPurchaseMove(late.toToken, t0 + MOVE_CONFIRM_SECONDS * 1000 + 1_000), { ok: false, reason: "link" });
  is("the request is gone too", await readPurchaseMove(late.id), null);

  part("At most three a day for one address");
  redis.clear();
  const tries = [];
  for (let i = 0; i <= MAX_MOVES_PER_ADDRESS_DAY; i++) tries.push(await askPurchaseMove({ from: "busy@example.com", to: `n${i}@example.com`, scope: "all", now: t0 }));
  is("three asked, the fourth refused", tries.map((t) => (t.ok ? "ok" : t.reason)), ["ok", "ok", "ok", "over"]);
  is("another address is not held back", (await askPurchaseMove({ from: "calm@example.com", to: "n@example.com", scope: "all", now: t0 })).ok, true);

  part("What cannot be read is unknown, never done or nobody");
  redis.clear();
  const u = await askPurchaseMove({ from: "e@example.com", to: "f@example.com", scope: "all", now: t0 });
  if (!u.ok) throw new Error("not asked");
  let undo = answer("INCR", "nl:pm:day:", "three");
  is("a day's count that cannot be read refuses", await askPurchaseMove({ from: "g@example.com", to: "h@example.com", scope: "all", now: t0 }), { ok: false, reason: "unknown" });
  undo();
  undo = answer("GET", "nl:pm:t:", 42);
  is("a link that cannot be read", await confirmPurchaseMove(u.fromToken, t0 + 1_000), { ok: false, reason: "unknown" });
  undo();
  undo = answer("SET", "nl:pm:r:", "QUEUED");
  is("a request not written exactly sends no links", await askPurchaseMove({ from: "i@example.com", to: "j@example.com", scope: "all", now: t0 }), { ok: false, reason: "unknown" });
  undo();
  undo = answer("GET", "nl:pm:c:", "yesterday");
  is("a confirmation that cannot be read is unknown, never none", await confirmPurchaseMove(u.fromToken, t0 + 1_000), { ok: false, reason: "unknown" });
  undo();
  undo = answer("GET", "nl:pm:r:", "{broken");
  is("a request that cannot be read is not claimed", await claimPurchaseMove(u.id, t0 + 1_000), { ok: false, reason: "unknown" });
  undo();
  await confirmPurchaseMove(u.fromToken, t0 + 1_000);
  await confirmPurchaseMove(u.toToken, t0 + 1_000);
  undo = answer("SET", "nl:pm:done:", "QUEUED");
  is("a claim whose mark cannot be confirmed does not move", await claimPurchaseMove(u.id, t0 + 2_000), { ok: false, reason: "unknown" });
  undo();

  part("A day's count always ends by itself, whatever one command of its step answers (Codex T on #3608)");
  const pipe = redis.pipeline;
  const dayKeys = () => redis.keys().filter((k) => k.startsWith("nl:pm:day:"));
  for (const lost of [null, 0, "1"]) {
    redis.clear();
    // A batch where the count's expiry is answered `lost` and never applied, every other command run as asked.
    redis.pipeline = async (commands: (string | number)[][]) =>
      Promise.all(commands.map(async (c) => (String(c[0]).toUpperCase() === "EXPIRE" && String(c[1]).startsWith("nl:pm:day:") ? lost : (await pipe([c]))[0])));
    await askPurchaseMove({ from: "k@example.com", to: "l@example.com", scope: "all", now: t0 });
    redis.pipeline = pipe;
    const ttls = dayKeys().map((k) => redis.run(["TTL", k]) as number);
    is(`the expiry answered ${JSON.stringify(lost)}: the day's count still ends within its two days`, ttls.length === 1 && ttls[0] > 0 && ttls[0] <= MOVE_MARK_SECONDS, true);
    advance((MOVE_MARK_SECONDS + 1) * 1000);
    is(`and two days later it is gone (${JSON.stringify(lost)})`, dayKeys(), []);
  }

  part("The register says what is kept, and for how long");
  is("expires by itself", PERSON_DATA.filter((d) => d.file === "lib/purchase-moves.ts").map((d) => d.how), ["expires"]);
  done();
}

main();
