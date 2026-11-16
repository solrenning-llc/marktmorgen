/** C4-1710: exercise the real reader; only its Redis reply is synthetic. */
import { readResponses } from "@/lib/form-store";
import { UnknownReply } from "@/lib/redis-exact";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

async function main() {
  const pipeline = redis.pipeline.bind(redis);
  const row = JSON.stringify({at: 1_800_000_000, answers: {field: "Synthetic answer"}});
  const cases: {name: string; reply: unknown[]; expected: string}[] = [
    {name:"confirmed empty",reply:[[],0],expected:"known:0:0"},
    {name:"confirmed answer",reply:[[row],1],expected:"known:1:1"},
    ...[
      ["missing results",[]], ["missing count",[[]]], ["extra result",[[],0,0]],
      ["null list",[null,0]], ["boolean list",[false,0]], ["object list",[{},0]],
      ["null row",[[null],1]], ["broken JSON",[["{"],1]],
      ["mixed list",[[row,null],2]], ["null count",[[],null]],
      ["boolean count",[[],false]], ["text count",[[],"1"]],
      ["negative count",[[],-1]], ["fractional count",[[],0.5]],
    ].map(([name,reply])=>({name:name as string,reply:reply as unknown[],expected:"unknown"})),
  ];
  part("Unknown response evidence must not become empty answers or zero");
  try {
    for (const scenario of cases) {
      let calls=0;
      redis.pipeline=async commands=>{
        if(calls>=1 || commands.length!==2 || commands[0][0]!=="LRANGE" || commands[1][0]!=="LLEN") throw Error("Unexpected IO beyond the existing two-command read");
        calls++;
        return scenario.reply;
      };
      let outcome="unexpected error";
      try {
        const result=await readResponses("synthetic-stats","abcdefghij",20);
        outcome=`known:${result.responses.length}:${result.total}`;
      } catch(error) {
        if(error instanceof UnknownReply) outcome="unknown";
      }
      console.log("FORM_READ_OBSERVATION",JSON.stringify({scenario:scenario.name,outcome,calls}));
      is(scenario.name+": exact evidence or explicit unknown",outcome,scenario.expected);
      is(scenario.name+": only the existing read",calls,1);
    }
  } finally { redis.pipeline=pipeline; }
  done();
}
void main().catch(error=>{console.error(error);process.exitCode=1;});
