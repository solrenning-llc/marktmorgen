import { log, setScript } from "@/lib/redis";
import { twoStepOn, lockedUntil } from "@/lib/two-step";
import { inviteMember } from "@/lib/team";
import { launch } from "@/lib/waitlist";
import { watchStripe } from "@/lib/webhooks";
import { firstSaleAt } from "@/lib/yearly-offer";

const SID = "0123456789abcdef0123456789abcdef";
const write = (c: unknown[]) => ["SET", "SREM", "DEL", "HSET", "HDEL", "SADD", "ZREM", "RPUSH"].includes(String(c[0]));

async function main() {
  (globalThis as any).fetch = async () => { throw new Error("no network"); };
  process.env.RESEND_API_KEY = "";

  // 1. two-step: account WITH an app on; the GET of its record answers undefined (short pipeline) -> "off".
  setScript((c) => c.map(() => undefined));
  console.log("1 twoStepOn on malformed GET:", await twoStepOn("owner@example.com"), "(signin-finish.ts:43 then opens a session with no second step)");
  setScript(() => []);
  console.log("1b twoStepOn on short pipeline []:", await twoStepOn("owner@example.com"));

  // 2. lockedUntil: a session locked until far in the future; MGET answers a non-list -> 0 (not locked).
  setScript((c) => c.map((cmd) => (cmd[0] === "MGET" ? { 0: `${Date.now() + 86_400_000}|1`, length: 3 } : undefined)));
  console.log("2 lockedUntil on MGET in another shape:", await lockedUntil("a".repeat(64)));

  // 3. team: two members + requireTwoStep; the GET read by readTeam answers undefined -> SET writes a team of only the invite.
  const stored = JSON.stringify({ members: [{ email: "a@example.com", role: "admin", joinedAt: "x" }, { email: "b@example.com", role: "support", joinedAt: "x" }], invites: [], requireTwoStep: true });
  let gets = 0;
  log.length = 0;
  setScript((c) => {
    if (c.length === 2 && c[0][0] === "SET" && c[1][0] === "INCR") return ["OK", 1];
    return c.map((cmd) => {
      if (cmd[0] === "SET" && cmd.includes("NX")) return "OK";
      if (cmd[0] === "EVAL") return 1;
      if (cmd[0] === "GET" && String(cmd[1]).startsWith("nl:team:") && !String(cmd[1]).includes("invite")) return gets++ === 0 ? undefined : stored;
      if (cmd[0] === "GET") return null;
      return "OK";
    });
  });
  const store = { sid: SID, statsId: SID, handle: "shop", name: "Shop", email: "owner@example.com", plan: "pro" } as any;
  const r3 = await inviteMember(store, "new@example.com", "support", "https://x").catch((e) => `THREW ${e}`);
  console.log("3 inviteMember:", JSON.stringify(r3));
  console.log("3 team SET written:", JSON.stringify(log.filter((c) => c[0] === "SET" && String(c[1]).startsWith("nl:team:") && !String(c[1]).includes(":invite:") && !String(c[1]).includes(":lock:") && !String(c[1]).includes("nl:rl:")).map((c) => JSON.parse(String(c[2])))));

  // 4. waitlist launch: HGETALL answers undefined -> total 0, SREM soon, DEL of the whole list.
  log.length = 0;
  setScript((c) => c.map((cmd) => (cmd[0] === "GET" ? null : cmd[0] === "HGETALL" ? undefined : 1)));
  const r4 = await launch({ statsId: SID, handle: "shop" } as any, { id: "prod1" } as any, { note: "", address: "" });
  console.log("4 launch:", JSON.stringify(r4), "writes:", JSON.stringify(log.filter(write)));

  // 5. webhooks watchStripe: the store's config GET answers undefined -> SREM from the stores whose Stripe events are read.
  log.length = 0;
  setScript((c) => c.map((cmd) => (cmd[0] === "SMEMBERS" ? [SID] : cmd[0] === "GET" && String(cmd[1]).includes("cfg") ? undefined : cmd[0] === "GET" ? null : "OK")));
  await watchStripe(Date.now() + 5_000).catch((e) => console.log("5 threw", String(e)));
  console.log("5 watchStripe writes:", JSON.stringify(log.filter(write)));

  // 6. firstSaleAt: a reply in another shape -> 0, which trial-nudges.ts:136 reads as "has not sold".
  setScript((c) => c.map(() => ({ weird: true })));
  console.log("6 firstSaleAt on malformed GET:", await firstSaleAt({ sid: SID, handle: "shop" } as any));
}
main().catch((e) => { console.error("THREW", e); process.exit(1); });
