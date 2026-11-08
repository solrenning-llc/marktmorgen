/** Rule 30 sibling of Claude 4's unreadable saved-group proof: a text member that cannot be parsed is unknown, not absent. */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { addLink, readLinks } from "@/lib/short-links";
import { MAX_LINKS } from "@/lib/short-link-rules";
import { store as redis } from "../../../tests/redis-stub";

for (const action of ["read", "cap", "name"] as const) {
  test(`unreadable kept short link preserves the ${action} boundary`, async () => {
    const store = { sid: `v2892-${action}`, statsId: `v2892${action}` };
    const key = `nl:slink:store:${store.statsId}`;
    const total = action === "cap" ? MAX_LINKS : 3;
    for (let i = 0; i < total; i += 1) assert.equal((await addLink(store, {name:`Post ${i}`,place:"x",target:{kind:"store"}},()=>false)).ok,true);
    const original = redis.pipeline;
    redis.pipeline = (async (commands: (string | number)[][]) => {
      const replies = await original.call(redis, commands);
      if(commands.length===1 && commands[0][0]==="HVALS" && commands[0][1]===key) {
        return [(replies[0] as string[]).map(raw => (JSON.parse(raw) as {name:string}).name === "post-0" ? "{" : raw)];
      }
      return replies;
    }) as typeof redis.pipeline;
    try {
      if(action==="read") await assert.rejects(()=>readLinks(store.statsId));
      else assert.deepEqual(await addLink(store,{name:action==="name"?"Post 0":"One more",place:"x",target:{kind:"store"}},()=>false),{ok:false,reason:"unavailable"});
    } finally { redis.pipeline=original; }
    assert.equal((await redis.pipeline([["HLEN",key]]))[0],total);
    const names = ((await redis.pipeline([["HVALS",key]]))[0] as string[]).map(raw=>(JSON.parse(raw) as {name:string}).name);
    assert.equal(names.filter(name=>name==="post-0").length,1);
  });
}
