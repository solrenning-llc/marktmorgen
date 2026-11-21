/**
 * Zoom's notice that a user removed the app (app/api/integrations/zoom/deauthorize, forgetUser in lib/meet-connect.ts)
 * is a company cost with a priced line (tests/plan-cost-registry.ts ZOOM_NOTICE_FORGET), held here to the code
 * (Claude 7's MEDIUM 2 on #3333).
 *
 * Before: the route was only a guard ("Zoom's own notices: a company cost.") with no price, while #3333 gave each
 * notice one more SET ... EX 86400 (the deletion's mark, kept a day) and turned the one final DEL/SREM of the index into
 * one SREM per store walked, up to FORGET_PASS a pass. Here the line is read against FORGET_PASS, GONE_SECONDS, the
 * route's PER_MINUTE and the renewal lock's wait, and against the commands a real pass of FORGET_PASS stores sends.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { FORGET_PASS, IncompleteForget, finishConsent, forgetUser } from "@/lib/meet-connect";
import { claimHandle, ensureStatsId, storeForEmail } from "@/lib/store";
import * as registry from "./plan-cost-registry";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.ZOOM_CLIENT_ID = "z-id";
process.env.ZOOM_CLIENT_SECRET = "z-secret";
process.env.ZOOM_WEBHOOK_SECRET_TOKEN = "z-token";
delete process.env.ZOOM_LIVE;
delete process.env.ZOOM_API_BASE;

const USER = "zoomCostUser01";
const hash = (value: string) => createHash("sha256").update(value).digest("hex").slice(0, 40);
/** The stores the Zoom user connected and the mark its deletion leaves (lib/meet-connect.ts userKey, goneKey). */
const index = `nl:meet:user:zoom:${hash(`meet-user:zoom:${USER}`)}`;
const mark = `nl:meet:gone:zoom:${hash(`meet-gone:zoom:${USER}`)}`;
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input));
  const json = (status: number, value: unknown) => new Response(JSON.stringify(value), { status });
  if (url.hostname === "zoom.us" && url.pathname === "/oauth/token") {
    return json(200, { access_token: "access-1", refresh_token: "refresh-1", expires_in: 3600, scope: "meeting:write:meeting user:read:user" });
  }
  if (url.hostname === "api.zoom.us" && url.pathname === "/v2/users/me") return json(200, { id: USER, email: "host@example.com", first_name: "Jenny", last_name: "Park" });
  return json(404, { message: "no stand-in" });
}) as typeof fetch;

type Command = (string | number)[];
type Line = {
  noticesPerAddressMinute: number;
  guardCommands: number;
  forgetFixedCommands: number;
  storesPerPass: number;
  lockWaitMs: number;
  lockTries: number;
  storeCommandsAfterLock: number;
  markBytes: number;
  markSeconds: number;
};

const source = (file: string) => readFileSync(file, "utf8");
const numberIn = (text: string, pattern: RegExp): number => Number((text.match(pattern)?.[1] ?? "NaN").replace(/_/g, ""));

/** lib/redis-lock.ts takeLock: one SET NX a try, waits of 20 ms doubling up to 250 ms, while they fit in `waitMs`. */
function lockTries(waitMs: number): number {
  let tries = 1;
  for (let wait = 20, waited = 0; waited + wait <= waitMs; wait = Math.min(wait * 2, 250)) {
    waited += wait;
    tries += 1;
  }
  return tries;
}

async function main(): Promise<void> {
  redis.clear();
  console.error = () => {};
  const line = (registry as Record<string, unknown>).ZOOM_NOTICE_FORGET as Line | undefined;
  const cost = (registry as Record<string, unknown>).zoomNoticeForgetCost as (() => { perNoticeUsd: number; perAddressMinuteUsd: number }) | undefined;

  part("Zoom's notice has a priced company line");
  is("tests/plan-cost-registry.ts has the line ZOOM_NOTICE_FORGET", typeof line, "object");
  is("and its price, zoomNoticeForgetCost", typeof cost, "function");
  if (!line || !cost) {
    done();
    return;
  }
  const meet = source("lib/meet-connect.ts");
  const route = source("app/api/integrations/zoom/deauthorize/route.ts");
  is("the stores a pass walks are FORGET_PASS", line.storesPerPass, FORGET_PASS);
  is("the mark is kept GONE_SECONDS", line.markSeconds, numberIn(meet, /const GONE_SECONDS = ([\d_]+);/));
  is("the mark is written with GONE_SECONDS as its expiry", /\["SET", goneKey\(provider, accountId\), String\(Date\.now\(\)\), "EX", GONE_SECONDS\]/.test(meet), true);
  is("the notices one address may send in a minute are the route's PER_MINUTE", line.noticesPerAddressMinute, numberIn(route, /const PER_MINUTE = ([\d_]+);/));
  is("the route counts them per address a minute", /withinLimit\("zoom-notice", clientAddress\(request\), PER_MINUTE, 60\)/.test(route), true);
  is("each store's lock waits what forgetUser waits", line.lockWaitMs, numberIn(meet, /withLock\(refreshLockKey\(statsId, provider\), 20, ([\d_]+), async \(\) =>/));
  is("and is tried at its most tries in that wait", line.lockTries, lockTries(line.lockWaitMs));
  // The route's own guard: windowCount's INCR and EXPIRE, claimMark's SET NX and its read back, releaseMark's script (EVAL, GET, DEL).
  is("the route still guards with withinLimit, claimMark and releaseMark", ["withinLimit(", "claimMark(", "releaseMark("].every((call) => route.includes(call)), true);
  is("its guard is counted at its most", line.guardCommands, 2 + 2 + 3);

  part("A real pass of FORGET_PASS stores sends no more than the line counts");
  const email = "zcost-one@example.com";
  await claimHandle(email, "zcost-one", "zcost-one", "");
  await ensureStatsId(email);
  const statsId = (await storeForEmail(email))!.statsId!;
  const owner = { email, handle: "zcost-one" };
  const kept = await finishConsent("zoom", { statsId, code: "code-1", verifier: "v".repeat(43), by: email, owner, startedAt: Date.now() });
  is("connected (set-up)", kept.ok, true);
  is("indexed under the Zoom user (set-up)", redis.run(["SISMEMBER", index, statsId]), 1);
  const connection = redis.run(["GET", `nl:meet:conn:${statsId}:zoom`]) as string;
  // One store more than a pass walks, every one connected to the same Zoom account: the pass is full.
  for (let i = 0; i < FORGET_PASS; i += 1) {
    const other = `zcoststore${String(i).padStart(4, "0")}`;
    redis.run(["SET", `nl:meet:conn:${other}:zoom`, connection]);
    redis.run(["SADD", index, other]);
  }
  const sent: Command[] = [];
  const pipeline = redis.pipeline.bind(redis);
  redis.pipeline = (async (commands: Command[]) => {
    sent.push(...commands);
    return pipeline(commands);
  }) as typeof redis.pipeline;
  const outcome = await forgetUser("zoom", USER).catch((error: unknown) => error);
  redis.pipeline = pipeline as typeof redis.pipeline;
  is("the pass stops at FORGET_PASS and says the rest wait", outcome instanceof IncompleteForget, true);
  is("it forgot FORGET_PASS stores", outcome instanceof IncompleteForget ? outcome.forgot.length : -1, FORGET_PASS);
  const scripts = sent.filter((c) => String(c[0]).toUpperCase() === "EVAL");
  is("its only scripts are the locks let go", scripts.every((c) => String(c[1]).startsWith("-- marktmorgen:release:v1\n")), true);
  // A script is counted as itself and the two commands it runs (GET, DEL), as the line counts it.
  const measured = sent.length + 2 * scripts.length;
  const linePerPass = line.forgetFixedCommands + line.storesPerPass * (line.lockTries + line.storeCommandsAfterLock);
  is("the pass sends, each lock taken at its first try, what the line counts with one try a store", measured, line.forgetFixedCommands + line.storesPerPass * (1 + line.storeCommandsAfterLock));
  is("and never more than the line's pass", measured <= linePerPass, true);
  const markValue = redis.run(["GET", mark]);
  is("the deletion's mark is kept", typeof markValue, "string");
  is("the mark's key and value fit the line's bytes, its value at the 16 digits the keep reads at most", mark.length + 16 <= line.markBytes && String(markValue).length <= 16, true);
  const ttl = Number(redis.run(["TTL", mark]));
  is("the mark expires within GONE_SECONDS", ttl > 0 && ttl <= line.markSeconds, true);

  part("The line's price is its commands and the mark kept, at the registry's rates");
  const commandsPerNotice = line.guardCommands + linePerPass;
  const perNotice = commandsPerNotice * registry.COMMAND + line.markBytes * registry.DB_BYTE_MONTH * (line.markSeconds / (30 * 86_400));
  const priced = cost();
  is("a notice at its most", Math.abs(priced.perNoticeUsd - perNotice) < 1e-15, true);
  is("an address's minute at its most notices", Math.abs(priced.perAddressMinuteUsd - perNotice * line.noticesPerAddressMinute) < 1e-12, true);
  is("not zero", priced.perAddressMinuteUsd > 0, true);
  is("the zoom-notice scope names the line", JSON.stringify(registry.SCOPES["zoom-notice"]).includes("ZOOM_NOTICE_FORGET"), true);

  done();
}

void main();
