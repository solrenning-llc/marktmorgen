import { log, setScript } from "@/lib/redis";
import { scoreMembers } from "@/lib/member-health";
import { nudgeFits } from "@/lib/member-health-rules";
import { forgetUser } from "@/lib/meet-connect";
import { forgetMetaUser } from "@/lib/meta-ads";
import { meetingFor } from "@/lib/meet-links";
import { heardFromSender } from "@/lib/mail-health";
import { forgetInvitesPerson } from "@/lib/move-members";
import { countOrder } from "@/lib/orders";
import { listPitches } from "@/lib/outreach";
import { usedLinkIn } from "@/lib/mail-clicks";

const section = async (name: string, f: () => Promise<void>) => { try { log.length = 0; await f(); } catch (e) { console.log(name, "THREW", (e as Error).message); } };

async function main() {
  await section("P1 member-health", async () => {
    // HMGET answers a list of the wrong length: lastSeenMany throws UnknownReplyError (rule-24 compliant)...
    setScript((c) => c.map((cmd) => (cmd[0] === "HMGET" ? ["garbage"] : null)));
    const now = Date.now();
    const rows = ["a@x.io", "b@x.io"].map((email, i) => ({ id: `sub_${i}`, status: "active", start_date: Math.floor(now / 1000) - 90 * 86400, customer: { email }, metadata: { store: "shop", product: "prod1" }, items: { data: [{ price: { unit_amount: 1000, recurring: { interval: "month" } }, current_period_end: Math.floor(now / 1000) + 86400 }] } }));
    const store = { handle: "shop", statsId: "s1", currency: "usd", community: null, sid: "x" } as any;
    const members = await scoreMembers(store, rows as any, now);
    console.log("P1 scoreMembers (lastSeenMany threw, caught as empty Map):", JSON.stringify(members.map((m) => ({ email: m.email, score: m.score, factors: m.factors.map((f) => f.reason), nudge: nudgeFits(m.score, m.factors) }))));
  });
  await section("P2 zoom forgetUser", async () => {
    setScript((c) => c.map((cmd) => (cmd[0] === "SMEMBERS" ? "not-a-list" : 1)));
    const forgot = await forgetUser("zoom", "zoomuser1");
    console.log("P2 forgetUser ->", JSON.stringify(forgot), "commands:", JSON.stringify(log));
  });
  await section("P2b meta forgetMetaUser", async () => {
    setScript((c) => c.map((cmd) => (cmd[0] === "SMEMBERS" ? undefined : 1)));
    const forgot = await forgetMetaUser("123456");
    console.log("P2b forgetMetaUser ->", JSON.stringify(forgot), "commands:", JSON.stringify(log));
  });
  await section("P3 meetingFor", async () => {
    // The lock is taken; the record GET answers with no result (undefined) -> read as "no record".
    setScript((c) => c.map((cmd) => (cmd[0] === "SET" ? "OK" : cmd[0] === "GET" ? undefined : cmd[0] === "EVAL" || cmd[0] === "EVALSHA" ? 1 : "OK")));
    const rec = await meetingFor({ store: { statsId: "0123456789abcdef01234567", handle: "shop", callsId: "calls1" } as any, provider: "google", scope: "c:calls1:t:prod1:1900000000000", product: "prod1", session: "", group: true, title: "Group call", description: "", start: 1900000000000, end: 1900003600000, tz: "UTC", guest: "late@x.io", fallback: async () => "https://fallback" } as any);
    console.log("P3 meetingFor returned link:", rec.link, "guests:", JSON.stringify(rec.guests));
    console.log("P3 record SETs:", JSON.stringify(log.filter((c) => c[0] === "SET" && String(c[1]).includes("rec") || (c[0] === "SET" && String(c[2]).startsWith("{")) ).map((c) => [c[0], c[1]])));
  });
  await section("P4 heardFromSender", async () => {
    // Same address bounces twice; SET NX reply has no result on the 2nd -> counted again.
    setScript((c) => c.map((cmd) => (cmd[0] === "SET" && cmd.includes("NX") ? undefined : cmd[0] === "HMGET" ? ["0", "0", "0"] : cmd[0] === "GET" ? null : 1)));
    const told = await heardFromSender({ kind: "bounced", permanent: true, to: "dead@x.io", store: "0123456789abcdef0123456789abcdef", list: "" });
    console.log("P4 heardFromSender ->", told, "HINCRBY sent:", JSON.stringify(log.filter((c) => c[0] === "HINCRBY")));
  });
  await section("P5 forgetInvitesPerson", async () => {
    setScript((c) => c.map((cmd) => (cmd[0] === "HMGET" ? undefined : 1)));
    const n = await forgetInvitesPerson({ sid: "sid1", statsId: "st1" }, ["prod1", "prod2"], "person@x.io");
    console.log("P5 forgetInvitesPerson records:", n, "deletes sent:", log.filter((c) => c[0] !== "HMGET").length);
  });
  await section("P6 countOrder", async () => {
    setScript((c) => c.map((cmd) => (cmd[0] === "SET" && cmd.includes("NX") ? undefined : cmd[0] === "INCR" ? 57 : cmd[0] === "GET" ? null : 1)));
    const counted = await countOrder({ handle: "shop", email: "owner@x.io", statsId: "st1", sid: "sid1", tier: "pro", trialEnds: 0, extra: false } as any, "cs_test_duplicate", 0);
    console.log("P6 countOrder on unknown NX reply ->", counted, "INCR sent:", JSON.stringify(log.filter((c) => c[0] === "INCR")));
  });
  await section("P7 listPitches", async () => {
    setScript((c) => c.map(() => 42));
    console.log("P7 listPitches on HGETALL=42 ->", JSON.stringify(await listPitches({ statsId: "st1" } as any)));
  });
  await section("P8 usedLinkIn", async () => {
    setScript((c) => c.map(() => undefined));
    console.log("P8 usedLinkIn all unknown ->", JSON.stringify([...(await usedLinkIn("list1", "s-0123456789abcdef-0123456789abcdef", ["a@x.io", "b@x.io"]))]));
  });
}
main().catch((e) => { console.error("THREW", e); process.exit(1); });
