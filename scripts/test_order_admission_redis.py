"""Exercise the actual order admission Lua (lib/order-admission.ts) against disposable local CI Redis.
No application credentials or production host configuration are read.
"""
import concurrent.futures
import os
from pathlib import Path
import re
import json
import subprocess
import tempfile
import threading
import uuid
from http.server import ThreadingHTTPServer
from test_form_opportunity_redis import Redis


def script(path, name):
    source = Path(path).read_text(encoding="utf-8")
    match = re.search(r"export const " + name + r" = `([^`]+)`;", source)
    if not match or "${" in match.group(1):
        raise RuntimeError("Expected static application script " + name)
    return match.group(1)


def tax_observations(root):
    """Actual TypeScript caller + composed Lua + real disposable Redis.

    Quotes, records and evidence here are synthetic, never a production policy.
    The HTTP fixture forwards commands once; a lost reply is not a Lua mock.
    """
    import test_self_hosted_redis_http as http_fixture
    # Extend only this local fixture instance; it still reaches loopback:16379.
    original_allowed = http_fixture.ALLOWED.copy()
    http_fixture.ALLOWED.update({"DEL", "TYPE", "PEXPIRETIME", "INFO"})
    server = ThreadingHTTPServer(("127.0.0.1", 0), http_fixture.Fixture)
    server.daemon_threads = True
    worker = threading.Thread(target=server.serve_forever, daemon=True)
    worker.start()
    prefix = "synthetic-tax-" + uuid.uuid4().hex
    source = r'''
import assert from "node:assert/strict";
import { observeCheckoutTaxPage, CURRENT_TAX_OBSERVATION_POLICY } from "@/lib/checkout-sweep";
import { redisPipeline } from "@/lib/redis";
import { dataKey } from "@/lib/store-data";
async function main(){
const now=Date.now(), expiry=now+120_000;
const store={sid:process.env.TAX_FIXTURE_ID, statsId:"synthetic", handle:"synthetic-tax",tier:"creator",stripeAccountId:"acct_fixtureTax",subscriptionActive:true,subscriptionId:"sub_SyntheticTax0001",trialEnds:0,planEndedAt:""} as any;
const policy={schema:1,purpose:"incomplete-checkout-observations",reviewId:"synthetic-not-approval",storeSid:store.sid,stripeAccountId:store.stripeAccountId,scopeEvidence:"Synthetic scope",retentionEvidence:"Synthetic two minutes",storageEvidence:"Synthetic bounded document",costEvidence:"Synthetic quotes, not real funding",reviewedAtMs:now,expiresAtMs:expiry,maxEntries:10,maxRecordBytes:512,maxDocumentBytes:16384,maxRetainedBytes:32768,storageMicroUsdPerGiBMonth:250000,retentionCostCeilingMicroUsd:100,commandMicroUsdPerMillion:2000000,transferMicroUsdPerGiB:1000000,maxChargedCommandsPerPass:720,maxTransferredBytesPerPass:1048576,computeCeilingMicroUsdPerPass:100,ioCostCeilingMicroUsdPerPass:10000};
const row=(n:number,amount=100)=>({id:"cs_test_SyntheticTax"+String(n).padStart(8,"0"),payment_status:"paid",created:Math.floor(now/1000),currency:"usd",amount_total:amount,metadata:{store:store.handle},customer_details:{email:"never-kept@example.test",address:{country:"CA",state:"ON",line1:"never-kept"}}});
const room=dataKey(store)!; const keys=new Set<string>([room]);
const original=globalThis.fetch; let loseAck=false, sent=0, journal="", journalRequestBytes=0;
globalThis.fetch=(async(input:any,init:any)=>{
 const url=new URL(String(input)); assert.equal(url.origin,new URL(process.env.UPSTASH_REDIS_REST_URL!).origin);
 const commands=JSON.parse(String(init.body));
 for(const c of commands) if(c[0]==="EVAL"&&String(c[1]).startsWith("-- marktmorgen:tax-observations:v1")){
  sent++; journalRequestBytes+=Buffer.byteLength(String(init.body)); journal=String(c[3]); keys.add(journal);
  if(loseAck){loseAck=false;init={...init,headers:{...init.headers,"X-Fixture-Lose-Ack":"1"}};}
 }
 return original(input,init);
}) as typeof fetch;
const one=async(c:any[]) => (await redisPipeline([c]))[0];
const observed=async(rows:any[],p:any=policy)=>observeCheckoutTaxPage(store,rows,p,now);
const missing=async()=>assert.equal(await one(["GET",journal]),null);
try {
 assert.equal(CURRENT_TAX_OBSERVATION_POLICY,null);
 assert.equal((await observeCheckoutTaxPage(store,[row(1)])).state,"not-recorded"); assert.equal(sent,0);
 await one(["HSET",room,"#",0]);
 const raced=await Promise.all(Array.from({length:16},()=>observed([row(1)])));
 assert.equal(raced.filter(r=>r.reason==="confirmed").length,1);
 assert.equal(raced.filter(r=>r.reason==="duplicate").length,15);
 assert.ok(raced.every(r=>r.legalCoverage==="incomplete"&&r.entries===1));
 const charged=Number(await one(["HGET",room,"#"])); assert.equal(charged,32768+64);
 const raw=String(await one(["GET",journal])); const doc=JSON.parse(raw);
 assert.equal(doc.bytes,Buffer.byteLength(raw));assert.equal(doc.order.length,1);
 assert.equal(await one(["PEXPIRETIME",journal]),expiry);
 assert.ok(!raw.includes("never-kept"));
 assert.deepEqual(JSON.parse(Object.values(doc.rows)[0] as string),{checkoutCreatedAt:Math.floor(now/1000),country:"CA",state:"ON",currency:"USD",amountTotalMinor:100,supplyOn:null,applicable:null});
 assert.equal((await observed([row(1,999)])).state,"unknown");assert.equal(await one(["GET",journal]),raw);
 assert.equal(Number(await one(["HGET",room,"#"])),charged);
 loseAck=true; assert.equal((await observed([row(2)])).state,"unknown");
 const afterLost=Number(await one(["HGET",room,"#"])); assert.equal(afterLost,charged+32768);
 const lostRaw=String(await one(["GET",journal])); assert.equal(JSON.parse(lostRaw).order.length,2);
 assert.equal(await one(["PEXPIRETIME",journal]),expiry);
 assert.equal((await observed([row(2)])).reason,"duplicate");assert.equal(Number(await one(["HGET",room,"#"])),afterLost);
 const capped=await Promise.all(Array.from({length:16},(_,i)=>observed([row(i+3)])));
 assert.equal(capped.filter(r=>r.state==="recorded").length,8);
 assert.equal(JSON.parse(String(await one(["GET",journal]))).order.length,10);
 assert.equal(Number(await one(["HGET",room,"#"])),10*32768+64);
 await one(["DEL",journal]); await one(["HSET",journal,"bad",1]);
 assert.equal((await observed([row(3)])).state,"unknown");assert.equal(await one(["TYPE",journal]),"hash");
 await one(["DEL",journal,room]);await one(["SET",room,"wrong"]);
 assert.equal((await observed([row(3)])).state,"unknown");await missing();
 await one(["DEL",room]);await one(["HSET",room,"#","unreadable"]);
 assert.equal((await observed([row(3)])).state,"unknown");await missing();
 await one(["DEL",room]);await one(["HSET",room,"#",0,"~","2026-10,2026-10","~2026-10",1]);
 assert.equal((await observed([row(3)])).state,"unknown");await missing();
 await one(["DEL",room]);await one(["HSET",room,"#",0]);
 // No expiry, corrupted bytes or extra fields never becomes an acknowledged journal.
 for(const value of [raw,"{}",JSON.stringify({...doc,unexpected:true})]){
  await one(["SET",journal,value]);assert.equal((await observed([row(3)])).state,"unknown");
  assert.equal(await one(["GET",journal]),value);assert.equal(Number(await one(["HGET",room,"#"])),0);
 }
 await one(["DEL",journal]);
 const before=sent;
 for(const bad of [{...policy,expiresAtMs:now+86400001},{...policy,retentionCostCeilingMicroUsd:0},{...policy,maxRetainedBytes:1}])assert.equal((await observed([row(3)],bad)).state,"not-recorded");
 assert.equal(sent,before);await missing();
 // Maximum three pages, a full month list and the largest document ceiling.
 // INFO commandstats includes commands invoked inside the actual Lua; the
 // extra INFO itself errs upward. This proves bounds, not real paid quotes.
 await one(["DEL",room]);
 const months=Array.from({length:32},(_,i)=>new Date(Date.UTC(2020,i,1)).toISOString().slice(0,7));
 await one(["HSET",room,"#",32*65,"~",months.join(","),...months.flatMap(m=>["~"+m,1])]);
 const wide={...policy,maxEntries:300,maxDocumentBytes:524288,maxRetainedBytes:660000};
 const commandCount=(text:any)=>[...String(text).matchAll(/^cmdstat_[^:]+:calls=(\d+)/gm)].reduce((sum,m)=>sum+Number(m[1]),0);
 const commandsBefore=commandCount(await one(["INFO","commandstats"]));const bytesBefore=journalRequestBytes;
 for(let page=0;page<3;page++)assert.equal((await observed(Array.from({length:100},(_,i)=>row(page*100+i+100)),wide)).state,"recorded");
 const measuredCommands=commandCount(await one(["INFO","commandstats"]))-commandsBefore;
 const measuredRequestBytes=journalRequestBytes-bytesBefore;
 assert.ok(measuredCommands>100&&measuredCommands<=wide.maxChargedCommandsPerPass);
 assert.ok(measuredRequestBytes+3*1024<wide.maxTransferredBytesPerPass); // replies fit in 1KiB each
 const full=String(await one(["GET",journal]));
 assert.equal(JSON.parse(full).order.length,300);assert.equal(JSON.parse(full).bytes,Buffer.byteLength(full));
 assert.equal(Number(await one(["HGET",room,"#"])),3*660000+64);
 assert.equal((await observed([row(999)],wide)).state,"unknown");assert.equal(await one(["GET",journal]),full);
 console.log(`PASS: actual maximum diagnostic pass measured ${measuredCommands} Redis commands and ${measuredRequestBytes} request bytes; full-retention price/funding remain synthetic`);
 console.log("PASS: actual diagnostic caller + real Redis: concurrency, conflict, absolute expiry, byte accounting, wrong types, missing policy and lost ACK (synthetic facts only)");
} finally {
 globalThis.fetch=original;await redisPipeline([["DEL",...keys]]);
}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
'''
    try:
        with tempfile.TemporaryDirectory(prefix="marktmorgen-tax-redis-") as tmp:
            bundle = str(Path(tmp) / "caller.cjs")
            build = "import{build}from'esbuild';await build(" + json.dumps({
                "stdin": {"contents": source, "resolveDir": str(root),
                          "loader": "ts", "sourcefile": "synthetic-tax-redis.ts"},
                "bundle": True, "platform": "node", "format": "cjs",
                "alias": {"@": str(root)}, "outfile": bundle,
                "logLevel": "error",
            }) + ");"
            subprocess.run(["node", "--input-type=module", "-e", build], cwd=root, check=True, timeout=60)
            env = {"PATH": os.environ["PATH"], "UPSTASH_REDIS_REST_URL":
                   "http://127.0.0.1:" + str(server.server_address[1]),
                   "UPSTASH_REDIS_REST_TOKEN": http_fixture.TOKEN,
                   "TAX_FIXTURE_ID": prefix}
            subprocess.run(["node", bundle], cwd=root, env=env, check=True, timeout=60)
    finally:
        server.shutdown()
        server.server_close()
        worker.join(timeout=5)
        http_fixture.ALLOWED.clear()
        http_fixture.ALLOWED.update(original_allowed)


def main():
    if os.environ.get("MARKTMORGEN_REDIS_INTEGRATION") != "1":
        raise RuntimeError("Run only against dedicated CI Redis on loopback port 16379")
    root = Path(__file__).resolve().parents[1]
    admit = script(root / "lib/order-admission.ts", "ADMIT_ORDERS")
    settle = script(root / "lib/order-admission.ts", "SETTLE_ADMITTED")
    prefix = "marktmorgen:integration:orders:" + uuid.uuid4().hex + ":"
    count, held, room, holding = prefix + "n", prefix + "open", prefix + "data", prefix + "open:b"
    hour = 500_000
    keep = 26 * 3600
    redis = Redis()

    def take(client, n=1, at=hour, limit=10, space=10**9, per=4096):
        return client.command("EVAL", admit, 4, count, held, room, holding, limit, n, at, at - 24, keep, space, n * per)

    def race(work, total=64):
        def run(index):
            client = Redis()
            try:
                return work(client, index)
            finally:
                client.close()
        with concurrent.futures.ThreadPoolExecutor(max_workers=16) as pool:
            return list(pool.map(run, range(total)))

    try:
        assert redis.command("PING") == "PONG"
        results = race(lambda client, _: take(client))
        assert sum(1 for r in results if r == 1) == 10 and all(r in (0, 1) for r in results)
        assert int(redis.command("HGET", held, str(hour))) == 10
        assert int(redis.command("HGET", holding, str(hour))) == 10 * 4096
        assert 0 < redis.command("TTL", held) <= keep and 0 < redis.command("TTL", holding) <= keep
        print("PASS: concurrent checkouts are admitted up to the figure and no further")

        redis.command("DEL", held, holding)
        redis.command("SET", count, 7)
        assert take(redis, n=3) == 1 and take(redis) == 0
        print("PASS: the month's counted orders and the open checkouts are added together")

        assert redis.command("EVAL", settle, 2, held, holding, str(hour), 1, 4096) == 1
        assert int(redis.command("HGET", held, str(hour))) == 2
        assert int(redis.command("HGET", holding, str(hour))) == 2 * 4096
        assert redis.command("EVAL", settle, 2, held, holding, str(hour), 5, 10**9) == 1
        assert redis.command("HEXISTS", held, str(hour)) == 0 and redis.command("HEXISTS", holding, str(hour)) == 0
        assert redis.command("EVAL", settle, 2, held, holding, str(hour), 1, 4096) == 0
        assert redis.command("EVAL", settle, 2, held, holding, str(hour), 1, -1) == 0
        print("PASS: a counted order gives its hour and its bytes back, never below zero")

        redis.command("SET", count, 0)
        redis.command("HSET", held, str(hour - 30), 9, str(hour - 3), 4)
        redis.command("HSET", holding, str(hour - 30), 9 * 4096, str(hour - 3), 4 * 4096)
        assert take(redis, n=6, at=hour) == 1
        assert redis.command("HEXISTS", held, str(hour - 30)) == 0 and redis.command("HEXISTS", holding, str(hour - 30)) == 0
        assert take(redis, n=1, at=hour) == 0
        print("PASS: checkouts older than a day fall out of the window by themselves")

        redis.command("SET", count, "not-a-number")
        assert take(redis) == -1
        redis.command("SET", count, 0)
        assert redis.command("EVAL", admit, 4, count, held, room, holding, 10, 0, hour, hour - 24, keep, 10**9, 4096) == -1
        assert redis.command("EVAL", admit, 4, count, held, room, holding, 10, 1, hour, hour - 24, keep, 10**9, -1) == -1
        print("PASS: an unreadable count or a malformed request admits nothing")

        redis.command("DEL", held, holding)
        redis.command("SET", count, 0)
        redis.command("HSET", room, "#", 10_000)
        # Room for 10,000 + 2 x 4,096 bytes: two open checkouts, not three.
        assert take(redis, space=20_000) == 1 and take(redis, space=20_000) == 1
        assert take(redis, space=20_000) == 2
        assert int(redis.command("HGET", held, str(hour))) == 2
        print("PASS: a checkout is held only while the data room has space for every open one's records")

        redis.command("DEL", held, holding)
        # Each checkout holds what its own orders can leave: one large one leaves no space for a small one.
        # 10,000 kept already: 25,000 and 8,000 fit in 45,000, 6,000 more does not, 2,000 does.
        assert take(redis, space=45_000, per=25_000) == 1 and take(redis, space=45_000, per=8_000) == 1
        assert take(redis, space=45_000, per=6_000) == 2 and take(redis, space=45_000, per=2_000) == 1
        assert int(redis.command("HGET", holding, str(hour))) == 35_000
        print("PASS: each checkout holds its own bytes, large or small")

        redis.command("DEL", held, holding)
        results = race(lambda client, _: take(client, space=10_000 + 5 * 4096, limit=1000))
        assert sum(1 for r in results if r == 1) == 5 and all(r in (1, 2) for r in results)
        print("PASS: concurrent checkouts never hold more data room than there is")

        redis.command("HSET", room, "#", "x")
        assert take(redis) == -1
        print("PASS: an unreadable data room admits nothing")
    finally:
        redis.command("DEL", count, held, room, holding)
        redis.close()
    tax_observations(root)


if __name__ == "__main__":
    main()
