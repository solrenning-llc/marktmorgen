import { log, setScript } from "@/lib/redis";
import { sent } from "@/lib/email";
import { GET as weekly } from "@/app/api/cron/weekly/route";
import { GET as recount } from "@/app/api/cron/recount/route";
import { GET as usage } from "@/app/api/cron/usage/route";
const req = () => ({ headers: new Headers({ authorization: "Bearer s3cret" }) }) as any;
process.env.CRON_SECRET = "s3cret";

async function weeklyCase(label: string, sismember: unknown, weekClaim: unknown) {
  log.length = 0; sent.length = 0;
  setScript((c) => c.map((cmd) => {
    if (cmd[0] === "SET" && cmd[1] === "nl:weekly:lock") return "OK";
    if (cmd[0] === "SISMEMBER") return sismember;
    if (cmd[0] === "SET" && cmd[3] === "NX") return weekClaim;
    if (cmd[0] === "SMEMBERS") return [];
    return null;
  }));
  const r = await weekly(req());
  console.log(`${label}: status ${r.status}`, JSON.stringify(await r.json()), "emails:", JSON.stringify(sent));
}

async function main() {
  console.log("== P1 weekly: owner pressed Stop (SISMEMBER) ==");
  await weeklyCase("  SISMEMBER=1 (confirmed Stop)    ", 1, "OK");
  await weeklyCase("  SISMEMBER=undefined (unknown)   ", undefined, "OK");
  await weeklyCase("  SISMEMBER='yes' (malformed)     ", "yes", "OK");
  console.log("== P2 weekly: claimWeek SET NX already taken ==");
  await weeklyCase("  claim=null (confirmed taken)    ", 0, null);
  await weeklyCase("  claim=undefined (unknown)       ", 0, undefined);

  console.log("== P3 recount route: lock SET NX reply undefined ==");
  for (const reply of [null, undefined]) {
    log.length = 0;
    setScript((c) => c.map((cmd) => (cmd[0] === "SET" ? reply : 1)));
    const r = await recount(req());
    console.log(`  lock reply=${String(reply)} ->`, JSON.stringify(await r.json()), "| commands:", JSON.stringify(log.map((c) => c.slice(0, 2))));
  }

  console.log("== P4 usage route: TOLD list GET reply ==");
  for (const told of ['["folderA"]', undefined, 42]) {
    log.length = 0; sent.length = 0;
    setScript((c) => c.map((cmd) => (cmd[0] === "GET" && cmd[1] === "nl:usage-watch:told" ? told : cmd[0] === "SMEMBERS" ? [] : null)));
    const r = await usage(req());
    console.log(`  TOLD=${JSON.stringify(told)} -> told=${(await r.json()).told}`, "emails:", JSON.stringify(sent.map((s) => s.subject)), "| TOLD rewritten:", JSON.stringify(log.filter((c) => c[0] === "SET").map((c) => c.slice(0, 3))));
  }
}
main().catch((e) => { console.error("THREW", e); process.exit(1); });
