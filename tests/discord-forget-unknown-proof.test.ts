import { emailKey } from "@/lib/learn";
import { accountOf, forgetServer, keepMember, saveServer } from "@/lib/discord-store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
const ROOM = "proofroom", SID = "sid_proof", ANA = "300000000000000031";
async function main() {
  for (const [cmd, odd] of [["HVALS", 42], ["HKEYS", 42], ["HVALS", "x"]] as [string, unknown][]) {
    redis.clear();
    await saveServer(ROOM, { id: "100000000000000031", name: "S", at: 1, kick: false });
    await keepMember(ROOM, SID, ANA, { e: "ana@example.com", n: "Ana", p: [], r: [], at: 1, checked: 1 });
    await redis.pipeline([["SET", `nl:dc:addr:${ROOM}:${emailKey("ana@example.com")}`, ANA]]);
    const real = redis.pipeline.bind(redis); let once = true;
    (redis as unknown as { pipeline: typeof real }).pipeline = async (cmds) => {
      if (once && cmds.length === 1 && cmds[0][0] === cmd) { once = false; return [odd] as never; }
      return real(cmds);
    };
    let out: unknown; try { out = await forgetServer(ROOM, SID); } catch (e) { out = "threw " + String(e).slice(0, 40); }
    (redis as unknown as { pipeline: typeof real }).pipeline = real;
    part(`${cmd} answered ${JSON.stringify(odd)}: forgetServer -> ${JSON.stringify(out)}`);
    is("address link to the Discord id left after disconnect", await accountOf(ROOM, "ana@example.com"), ANA);
    is("due entry left", (await real([["ZSCORE", "nl:dc:due", `${SID}|${ANA}`]]))[0] !== null, true);
  }
  done();
}
main();
