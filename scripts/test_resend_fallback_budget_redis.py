"""Exercise the actual global fallback Lua on disposable loopback Redis.

No provider/account credentials or real messages are used. In CI, use the
existing dedicated Redis with MARKTMORGEN_REDIS_INTEGRATION=1. Locally pass
--redis-server /path/to/reviewed/redis-server; only that subprocess is stopped.
Observed commandstats counts are Redis commands, not a supplier invoice.
The delayed-ACK case loads the exact TypeScript API with Node24's native
type stripping, with no provider credentials or extra runtime dependency.
"""
import argparse
import concurrent.futures
import hashlib
import json
import os
from pathlib import Path
import re
import socket
import subprocess
import tempfile
import time
import threading
import urllib.request
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


class Redis:
    def __init__(self, port):
        self.sock = socket.create_connection(("127.0.0.1", port), timeout=10)
        self.stream = self.sock.makefile("rb")

    def close(self):
        self.stream.close()
        self.sock.close()

    def command(self, *parts):
        encoded = [str(part).encode() for part in parts]
        packet = b"*" + str(len(encoded)).encode() + b"\r\n"
        for part in encoded:
            packet += b"$" + str(len(part)).encode() + b"\r\n" + part + b"\r\n"
        self.sock.sendall(packet)
        return self.read()

    def read(self):
        line = self.stream.readline()
        if not line.endswith(b"\r\n"):
            raise RuntimeError("Incomplete synthetic Redis reply")
        kind, raw = line[:1], line[1:-2]
        if kind == b"+":
            return raw.decode()
        if kind == b"-":
            raise RuntimeError(raw.decode())
        if kind == b":":
            return int(raw)
        if kind == b"$":
            size = int(raw)
            if size == -1:
                return None
            value = self.stream.read(size + 2)
            if len(value) != size + 2 or not value.endswith(b"\r\n"):
                raise RuntimeError("Incomplete Redis bulk reply")
            return value[:-2].decode()
        if kind == b"*":
            count = int(raw)
            return None if count == -1 else [self.read() for _ in range(count)]
        raise RuntimeError("Unknown Redis response")


NATIVE_CLOCK_DRIVER = r'''
import assert from 'node:assert/strict';
import { createConnection } from 'node:net';
import { createHash, randomBytes } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
const cfg=JSON.parse(process.argv[2]);
const budget=await import(pathToFileURL(cfg.module).href);
async function pipeline(commands){
 const encoded=commands.map(c=>`*${c.length}\r\n`+c.map(v=>{const s=String(v);return `$${Buffer.byteLength(s)}\r\n${s}\r\n`}).join('')).join('');
 return new Promise((resolve,reject)=>{
  const socket=createConnection({host:'127.0.0.1',port:cfg.port});let buffer=Buffer.alloc(0);
  function parse(start){
   const end=buffer.indexOf('\r\n',start);if(end<0)return null;const kind=String.fromCharCode(buffer[start]),v=buffer.toString('utf8',start+1,end),next=end+2;
   if(kind==='+')return{value:v,end:next};if(kind==='-')throw Error(v);if(kind===':')return{value:Number(v),end:next};
   if(kind==='$'){const n=Number(v);if(n===-1)return{value:null,end:next};if(buffer.length<next+n+2)return null;return{value:buffer.toString('utf8',next,next+n),end:next+n+2};}
   if(kind==='*'){const n=Number(v);if(n===-1)return{value:null,end:next};let cursor=next;const out=[];for(let i=0;i<n;i++){const item=parse(cursor);if(!item)return null;out.push(item.value);cursor=item.end;}return{value:out,end:cursor};}throw Error('Invalid isolated Redis reply');
  }
  socket.setTimeout(5000,()=>socket.destroy(Error('Isolated Redis timeout')));socket.on('error',reject);socket.on('connect',()=>socket.write(encoded));
  socket.on('data',chunk=>{buffer=Buffer.concat([buffer,chunk]);try{let cursor=0;const out=[];for(let i=0;i<commands.length;i++){const item=parse(cursor);if(!item)return;out.push(item.value);cursor=item.end;}socket.end();resolve(out);}catch(e){socket.destroy();reject(e);}});
 });
}
const one=async c=>(await pipeline([c]))[0];
const hash=s=>createHash('sha256').update(s).digest('hex');
const accountId='synthetic:monotonic:'+randomBytes(8).toString('hex'),attemptId='synthetic:deadline:'+randomBytes(8).toString('hex');
const keys=budget.resendFallbackBudgetKeys(accountId,attemptId),realNow=Date.now;
let posts=0;
try{
 const clock=await one(['TIME']),anchor=Number(clock[0])*1000+Math.floor(Number(clock[1])/1000);
 const reset=anchor+1500,start=reset-31*86400000;
 Date.now=()=>anchor;
 const review={schema:1,reviewId:'synthetic:deadline',accountId,paidPlan:'Pro',paidForPeriod:true,includedEmails:1,periodStartMs:start,resetsAtMs:reset,checkedAtMs:anchor-1,validUntilMs:reset,evidence:'Synthetic only, not financial approval',protection:{kind:'inclusive_provider_hard_cap',sentAndReceived:true,overagesDisabled:true,capEmails:1,evidence:'Synthetic only'},bootstrap:{noUnresolvedPriorAttempts:true,allPriorUsageIncluded:true,evidence:'Synthetic empty fixture'}};
 const usage={source:'resend_usage_api',accountId,observedAtMs:anchor,monthly:{used:0,sent:0,received:0,limit:1,resetsAt:new Date(reset).toISOString()}};
 assert.equal((await budget.initializeResendFallbackBudget({review,usage},{pipeline})).status,'initialized');
 const held=await budget.reserveResendFallback({review,usage,attemptId,recipients:1,payloadFingerprint:hash('synthetic final body')},{pipeline});assert.equal(held.status,'reserved');
 // Admission has setup slack. Approach its ORIGINAL reset without changing it.
 if(cfg.case!=='healthy')await new Promise(resolve=>setTimeout(resolve,Math.max(0,reset-realNow()-500)));
 const authorizationWall=realNow();
 Date.now=cfg.case==='moving_offset'?()=>realNow()-400:cfg.case==='large_offset'?()=>authorizationWall-73*3600000:cfg.case==='healthy'?realNow:()=>authorizationWall;
 const delay=cfg.case==='healthy'||cfg.case==='consumer_delay'?0:cfg.case==='moving_offset'?606:650;
 const sdk={pipeline:async commands=>{const result=await pipeline(commands);if(commands[0][5]==='dispatch'&&delay)await new Promise(resolve=>setTimeout(resolve,delay));return result;}};
 const began=performance.now(),permission=await budget.markResendFallbackDispatched(held.claim,sdk),elapsed=performance.now()-began;
 if(cfg.case==='consumer_delay')await new Promise(resolve=>setTimeout(resolve,650));
 // The consumer is deliberately minimal: the real transport has its own
 // independent integration review. No await follows this final guard.
 let postAt=null;
 if(permission.status==='dispatch'&&Date.now()<permission.sendBeforeMs&&(cfg.unsafe||performance.now()<permission.sendBeforeMonotonicMs)){
  const response=await fetch(cfg.base,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({syntheticCase:cfg.case,reset})});
  assert.equal(response.status,200);postAt=(await response.json()).at;posts++;
 }
 const state=await one(['HMGET',keys[0],'held','spent']);assert.deepEqual(state,['1','0']);
 if(cfg.case==='healthy'){assert.equal(posts,1);assert.ok(postAt<reset);}
 else if(cfg.case==='large_offset'){assert.equal(posts,0);}
 else if(cfg.unsafe){assert.equal(posts,1);assert.ok(postAt>=reset);}
 else{assert.equal(posts,0);if(cfg.case!=='consumer_delay')assert.equal(permission.status,'unknown');}
 console.log(JSON.stringify({case:cfg.case,unsafe:cfg.unsafe,posts,postAt,reset,permission:permission.status,dispatchRttMs:elapsed}));
}finally{Date.now=realNow;await one(['DEL',...keys]);}
'''


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--redis-server")
    parser.add_argument("--port", type=int, default=16481)
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[1]
    source = (root / "lib/resend-fallback-budget.ts").read_text()
    found = re.search(r"export const RESEND_FALLBACK_BUDGET_LUA = `([^`]+)`;", source)
    if not found or "${" in found.group(1):
        raise RuntimeError("Expected the exact static application Lua")
    script = found.group(1)
    owned = None
    temp = tempfile.TemporaryDirectory(prefix="marktmorgen-resend-budget-redis-")
    if args.redis_server:
        binary = Path(args.redis_server).resolve()
        version = subprocess.check_output([str(binary), "--version"], text=True).strip()
        digest = hashlib.sha256(binary.read_bytes()).hexdigest()
        print(json.dumps({"redis_version": version, "binary_sha256": digest, "loopback_port": args.port}))
        # Never select an occupied port or stop someone else's instance.
        with socket.socket() as probe:
            probe.bind(("127.0.0.1", args.port))
        owned = subprocess.Popen([str(binary), "--bind", "127.0.0.1", "--protected-mode", "yes", "--port", str(args.port), "--save", "", "--appendonly", "no", "--dir", temp.name], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        port = args.port
        until = time.monotonic() + 10
        while True:
            if owned.poll() is not None:
                raise RuntimeError("The isolated Redis exited before startup")
            try:
                client = Redis(port)
                break
            except OSError:
                if time.monotonic() >= until:
                    owned.terminate()
                    raise
                time.sleep(0.05)
    else:
        if os.environ.get("MARKTMORGEN_REDIS_INTEGRATION") != "1":
            raise RuntimeError("Use a dedicated CI Redis or --redis-server; never production")
        port = 16379
        client = Redis(port)
    touched = set()
    def redis_now(connection=None):
        clock = (connection or client).command("TIME")
        return int(clock[0]) * 1000 + int(clock[1]) // 1000

    anchor = redis_now()
    start = anchor - 15 * 86_400_000
    reset = start + 31 * 86_400_000
    serial = 0

    def account():
        nonlocal serial
        serial += 1
        return hashlib.sha256(("synthetic-resend-budget:" + uuid.uuid4().hex + ":" + str(serial)).encode()).hexdigest()

    def keys(acc, attempt):
        pair = ("nl:resend-budget:{" + acc + "}:ledger", "nl:resend-budget:{" + acc + "}:claim:" + hashlib.sha256(attempt.encode()).hexdigest())
        touched.update(pair)
        return pair

    dispatches = {}
    fingerprint = hashlib.sha256(b"synthetic final body").hexdigest()

    def call(acc, attempt, op="reserve", *, token="a" * 32, units=1, cap=10, used=0, sent=None, now=None, period_start=start, period_reset=reset, until=None, observed=None, prior=None, outcome="", connection=None, lua_override=None, dispatch=None, payload=fingerprint):
        if now is None:
            now = redis_now(connection)
        if dispatch is None:
            dispatch = uuid.uuid4().hex if op == "dispatch" else ""
        if until is None:
            until = min(now + 60_000, period_reset)
        if observed is None:
            observed = now
        if sent is None:
            sent = used
        prior = prior or [0, 0, 0, 0]
        flag = "bootstrap_reviewed" if op == "initialize" else "period_closed" if prior[1] else ""
        argv = [op, acc, token, units, period_start, period_reset, now, until, cap, observed, used, sent, used - sent, hashlib.sha256(attempt.encode()).hexdigest(), *prior, outcome, flag, payload, dispatch]
        return (connection or client).command("EVAL", lua_override or script, 2, *keys(acc, attempt), *argv)

    def initialize(acc, **kwargs):
        assert call(acc, "bootstrap", "initialize", **kwargs) == ["initialized"]

    def claim_call(acc, attempt, saved, op, outcome="", now=None, dispatch=None, **kwargs):
        identity = (acc, attempt, saved[1])
        if dispatch is None:
            dispatch = uuid.uuid4().hex if op == "dispatch" else dispatches.get(identity, "")
        result = call(acc, attempt, op, token=saved[1], units=int(saved[2]), period_start=int(saved[3]), period_reset=int(saved[4]), until=int(saved[5]), outcome=outcome, now=now, dispatch=dispatch, **kwargs)
        if op == "dispatch" and result[0] == "dispatch":
            dispatches[identity] = result[4]
        return result

    def stats():
        raw = client.command("INFO", "commandstats")
        return {name: int(calls) for name, calls in re.findall(r"^cmdstat_([^:]+):calls=(\d+)", raw, re.M)}

    def in_flight_race(lua_override=None):
        """Real local HTTP POST A stays in flight while B refuses locally.

        This is a synthetic provider, not Resend. The real production Lua
        supplies permissions; the red control weakens only cancel's CAS.
        """
        posts = []
        began, finish = threading.Event(), threading.Event()

        class Provider(BaseHTTPRequestHandler):
            def log_message(self, *_args):
                pass

            def do_POST(self):
                value = self.rfile.read(int(self.headers["Content-Length"])).decode()
                posts.append(value)
                if value == "synthetic A":
                    began.set()
                    if not finish.wait(5):
                        self.close_connection = True
                        return
                body = b'{"id":"synthetic accepted"}'
                self.send_response(200)
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

        server = ThreadingHTTPServer(("127.0.0.1", 0), Provider)
        worker = threading.Thread(target=server.serve_forever, daemon=True)
        worker.start()

        def post(value):
            request = urllib.request.Request("http://127.0.0.1:" + str(server.server_address[1]), data=value.encode(), method="POST")
            with urllib.request.urlopen(request, timeout=5) as response:
                return response.status

        try:
            acc = account(); initialize(acc, cap=1)
            a = call(acc, "same-intent", cap=1)
            b = call(acc, "same-intent", cap=1, token="b" * 32)
            assert b == ["already_reserved", *a[1:]]
            assert claim_call(acc, "same-intent", a, "dispatch")[0] == "dispatch"
            with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
                pending_post = pool.submit(post, "synthetic A")
                try:
                    assert began.wait(5)
                    # B has no dispatch capability, even though its hold token
                    # equals A's. A generic not-accepted settlement is denied.
                    assert claim_call(acc, "same-intent", b, "settle", "confirmed_not_accepted", dispatch="") == ["denied", "dispatch_conflict"]
                    canceled = claim_call(acc, "same-intent", b, "cancel", lua_override=lua_override)
                    c = call(acc, "independent-intent-C", cap=1)
                    if lua_override is None:
                        assert canceled == ["denied", "not_reserved"]
                        assert c == ["denied", "exhausted"]
                    else:
                        assert canceled == ["released"] and c[0] == "reserved"
                        assert claim_call(acc, "independent-intent-C", c, "dispatch")[0] == "dispatch"
                        assert post("synthetic C") == 200
                        assert claim_call(acc, "independent-intent-C", c, "settle", "accepted") == ["settled", "accepted"]
                finally:
                    finish.set()
                assert pending_post.result(timeout=5) == 200
            settled = claim_call(acc, "same-intent", a, "settle", "accepted")
            assert settled == (["settled", "accepted"] if lua_override is None else ["already_settled", "confirmed_not_accepted"])
            assert [int(x) for x in client.command("HMGET", keys(acc, "same-intent")[0], "spent", "held")] == [1, 0]
            assert len(posts) == (1 if lua_override is None else 2), posts
        finally:
            finish.set()
            server.shutdown(); server.server_close(); worker.join(timeout=5)

    def delayed_clock_authorization():
        """Exact TS API + real Lua + delayed ACK + real loopback HTTP.

        The red control removes only the API's elapsed guard and uses the
        former wall-only consumer. A fixed one-second timeout cannot prevent
        the moving-offset case: its ACK takes606ms across the final500ms before reset.
        """
        class Provider(BaseHTTPRequestHandler):
            def log_message(self, *_args):
                pass

            def do_POST(self):
                self.rfile.read(int(self.headers["Content-Length"]))
                body = json.dumps({"at": int(time.time() * 1000)}).encode()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

        server = ThreadingHTTPServer(("127.0.0.1", 0), Provider)
        worker = threading.Thread(target=server.serve_forever, daemon=True)
        worker.start()
        try:
            with tempfile.TemporaryDirectory(prefix="resend-deadline-native-") as tmp:
                driver = Path(tmp) / "clock.mjs"
                driver.write_text(NATIVE_CLOCK_DRIVER)
                actual = root / "lib/resend-fallback-budget.ts"
                unsafe = Path(tmp) / "unsafe-budget.ts"
                source = actual.read_text()
                guard = " || performance.now() >= sendBeforeMonotonicMs"
                assert source.count(guard) == 1
                unsafe.write_text(source.replace(guard, ""))
                for red, cases in [(False, ["frozen", "moving_offset", "large_offset", "consumer_delay", "healthy"]),
                                   (True, ["frozen", "moving_offset", "consumer_delay"])]:
                    for case in cases:
                        config = {"module": str(unsafe if red else actual), "port": port,
                                  "base": "http://127.0.0.1:" + str(server.server_address[1]),
                                  "unsafe": red, "case": case}
                        result = subprocess.run(["node", "--experimental-strip-types", str(driver), json.dumps(config)],
                                                cwd=root, capture_output=True, text=True, timeout=10)
                        if result.returncode:
                            raise AssertionError(result.stdout + result.stderr)
                        print(result.stdout.strip())
        finally:
            server.shutdown(); server.server_close(); worker.join(timeout=5)
        print("PASS: exact TS API consumes Redis-relative permission before RPC; frozen/moving400ms offset and delayed606/650ms ACK cannot POST after reset; healthy path posts")

    try:
        assert client.command("PING") == "PONG"
        acc = account()
        assert call(acc, "missing") == ["denied", "uninitialized"]
        assert client.command("EXISTS", keys(acc, "missing")[0]) == 0
        initialize(acc, used=5, sent=2)
        held = call(acc, "last-five", units=5, used=5, sent=2)
        assert held[0] == "reserved" and call(acc, "over", used=5, sent=2) == ["denied", "exhausted"]
        assert int(client.command("HGET", keys(acc, "last-five")[0], "held")) == 5
        print("PASS: missing state is not zero; sent plus received consumes the paid cap")

        race_account = account()
        initialize(race_account, observed=anchor)
        def reserve_race(index):
            other = Redis(port)
            try:
                return call(race_account, "race:" + str(index), token=format(index, "032x"), connection=other, observed=anchor)
            finally:
                other.close()
        with concurrent.futures.ThreadPoolExecutor(max_workers=16) as pool:
            raced = list(pool.map(reserve_race, range(64)))
        assert sum(row[0] == "reserved" for row in raced) == 10
        assert all(row[0] == "reserved" or row == ["denied", "exhausted"] for row in raced)
        assert int(client.command("HGET", keys(race_account, "race:0")[0], "held")) == 10
        print("PASS: 64 concurrent reservations cannot exceed ten remaining emails")

        in_flight_race()
        cancel_guard = "if c[10]~='reserved' then return no('not_reserved') end"
        assert script.count(cancel_guard) == 1
        unsafe_cancel = script.replace(cancel_guard, "if c[10]~='reserved' and c[10]~='dispatched' then return no('not_reserved') end")
        in_flight_race(unsafe_cancel)
        print("PASS: A POST in flight + B local refusal keeps its hold; C cannot POST at quota1 (red control reproduces2 POSTs)")

        acc = account(); initialize(acc)
        original = call(acc, "lost-reserve", units=2)
        # The first response is deliberately discarded, as after a committed SET.
        again = call(acc, "lost-reserve", token="b" * 32, units=2)
        assert again == ["already_reserved", *original[1:]]
        def dispatch_race(_):
            other = Redis(port)
            try:
                return call(acc, "lost-reserve", "dispatch", token=original[1], units=2, connection=other, period_start=int(original[3]), period_reset=int(original[4]), until=int(original[5]))
            finally:
                other.close()
        with concurrent.futures.ThreadPoolExecutor(max_workers=16) as pool:
            dispatched = list(pool.map(dispatch_race, range(64)))
        assert sum(row[0] == "dispatch" for row in dispatched) == 1
        dispatches[(acc, "lost-reserve", original[1])] = next(row[4] for row in dispatched if row[0] == "dispatch")
        assert all(row[0] == "dispatch" or row == ["denied", "already_dispatched"] for row in dispatched)
        assert claim_call(acc, "lost-reserve", original, "dispatch") == ["denied", "already_dispatched"]
        assert claim_call(acc, "lost-reserve", original, "settle", "unknown") == ["settled", "unknown"]
        assert client.command("TTL", keys(acc, "lost-reserve")[1]) == -1
        assert claim_call(acc, "lost-reserve", original, "settle", "accepted") == ["settled", "accepted"]
        assert claim_call(acc, "lost-reserve", original, "settle", "accepted") == ["already_settled", "accepted"]
        assert claim_call(acc, "lost-reserve", original, "settle", "confirmed_not_accepted") == ["already_settled", "accepted"]
        assert [int(x) for x in client.command("HMGET", keys(acc, "lost-reserve")[0], "held", "spent")] == [0, 2]
        assert 0 < client.command("TTL", keys(acc, "lost-reserve")[1]) <= 35 * 86400
        print("PASS: lost ACKs and concurrent replays grant at most one POST; uncertainty retains the whole hold")

        acc = account(); initialize(acc)
        reserved = call(acc, "not-sent", units=3)
        assert claim_call(acc, "not-sent", reserved, "settle", "unknown") == ["denied", "dispatch_conflict"]
        assert claim_call(acc, "not-sent", reserved, "cancel") == ["released"]
        assert claim_call(acc, "not-sent", reserved, "cancel") == ["already_released"]
        assert [int(x) for x in client.command("HMGET", keys(acc, "not-sent")[0], "held", "spent", "attempts")] == [0, 0, 1]
        rearmed = call(acc, "not-sent", token="c" * 32, units=3)
        assert rearmed[0] == "reserved" and rearmed[1] != reserved[1]
        assert client.command("TTL", keys(acc, "not-sent")[1]) == -1
        assert claim_call(acc, "not-sent", reserved, "cancel") == ["denied", "claim_conflict"]
        assert claim_call(acc, "not-sent", rearmed, "cancel") == ["released"]
        assert int(client.command("HGET", keys(acc, "not-sent")[0], "attempts")) == 2
        assert call(acc, "next", units=10)[0] == "reserved"
        print("PASS: confirmed nonacceptance releases once, without resetting the attempts bound")

        acc = account(); initialize(acc, cap=1)
        old = call(acc, "rearmed-http", cap=1)
        claim_call(acc, "rearmed-http", old, "dispatch")
        old_dispatch = dispatches[(acc, "rearmed-http", old[1])]
        assert claim_call(acc, "rearmed-http", old, "settle", "confirmed_not_accepted") == ["settled", "confirmed_not_accepted"]
        fresh = call(acc, "rearmed-http", cap=1, token="b" * 32)
        assert fresh[0] == "reserved" and fresh[1] != old[1]
        claim_call(acc, "rearmed-http", fresh, "dispatch")
        assert claim_call(acc, "rearmed-http", old, "settle", "confirmed_not_accepted") == ["denied", "claim_conflict"]
        assert claim_call(acc, "rearmed-http", fresh, "settle", "confirmed_not_accepted", dispatch=old_dispatch) == ["denied", "dispatch_conflict"]
        assert claim_call(acc, "rearmed-http", fresh, "cancel") == ["denied", "not_reserved"]
        assert claim_call(acc, "rearmed-http", fresh, "settle", "unknown") == ["settled", "unknown"]
        assert call(acc, "cannot-reuse-fresh-hold", cap=1) == ["denied", "exhausted"]
        assert int(client.command("HGET", keys(acc, "rearmed-http")[0], "held")) == 1
        print("PASS: stale reservation/dispatch tokens cannot settle a rearmed or another invocation's hold; unknown never releases")

        for before_expiry in (True, False):
            acc = account(); initialize(acc, cap=1)
            saved = call(acc, "partial-cancel", cap=1)
            tail = "redis.call('PEXPIREAT',KEYS[2],expiry)\n redis.call('HINCRBY',KEYS[1],'held',-units)\n return {'released'}"
            assert script.count(tail) == 1
            replacement = "error('synthetic cancel interruption'); " + tail if before_expiry else tail.replace("redis.call('HINCRBY'", "error('synthetic cancel interruption'); redis.call('HINCRBY'", 1)
            try:
                claim_call(acc, "partial-cancel", saved, "cancel", lua_override=script.replace(tail, replacement))
                raise AssertionError("Cancel fault did not execute")
            except RuntimeError as error:
                assert "synthetic cancel interruption" in str(error)
            expected = ["denied", "claim_shape"] if before_expiry else ["already_released"]
            assert claim_call(acc, "partial-cancel", saved, "cancel") == expected
            assert int(client.command("HGET", keys(acc, "partial-cancel")[0], "held")) == 1
            assert call(acc, "no-free-after-partial-cancel", cap=1) == ["denied", "exhausted"]
        acc = account(); initialize(acc, cap=1)
        saved = call(acc, "lost-dispatch", cap=1)
        response = claim_call(acc, "lost-dispatch", saved, "dispatch")
        assert response[0] == "dispatch"  # Discarded: the caller did not observe the permission.
        assert claim_call(acc, "lost-dispatch", saved, "dispatch") == ["denied", "already_dispatched"]
        assert claim_call(acc, "lost-dispatch", saved, "cancel") == ["denied", "not_reserved"]
        assert claim_call(acc, "lost-dispatch", saved, "settle", "confirmed_not_accepted", dispatch="") == ["denied", "dispatch_conflict"]
        assert call(acc, "no-free-after-dispatch-ack", cap=1) == ["denied", "exhausted"]
        print("PASS: partial cancel and lost dispatch acknowledgement retain quota and cannot open another POST")

        # Acceptance is recovered only from one complete payload-bound receipt.
        acc = account(); initialize(acc)
        saved = call(acc, "accepted-receipt")
        claim_call(acc, "accepted-receipt", saved, "dispatch")
        assert claim_call(acc, "accepted-receipt", saved, "settle", "accepted") == ["settled", "accepted"]
        ledger, receipt_key = keys(acc, "accepted-receipt")
        absolute = client.command("PEXPIRETIME", receipt_key)
        before_read = client.command("HGETALL", ledger)
        proof = call(acc, "accepted-receipt", "receipt")
        assert proof[:5] == ["accepted", acc, hashlib.sha256(b"accepted-receipt").hexdigest(), fingerprint, "1"]
        assert int(proof[6]) - int(proof[5]) == 35 * 86_400_000
        assert int(proof[5]) <= int(proof[7]) < int(proof[6])
        assert client.command("PEXPIRETIME", receipt_key) == absolute
        assert client.command("HGETALL", ledger) == before_read
        assert call(acc, "accepted-receipt", "receipt", payload="e" * 64) == ["denied", "receipt_unknown"]
        assert call(acc, "accepted-receipt", "receipt", units=2) == ["denied", "receipt_unknown"]
        assert call(acc, "not-this-intent", "receipt") == ["denied", "receipt_unknown"]
        fields = client.command("HGETALL", receipt_key)
        restore = lambda: (client.command("DEL", receipt_key), client.command("HSET", receipt_key, *fields), client.command("PEXPIREAT", receipt_key, absolute))
        for field, bad in [("schema", "1"), ("account", "e" * 64), ("attempt", "e" * 64), ("fingerprint", ""), ("state", "unknown"), ("dispatchToken", ""), ("units", "01"), ("acceptedAt", "0"), ("expiresAt", str(absolute + 1))]:
            client.command("HSET", receipt_key, field, bad)
            assert call(acc, "accepted-receipt", "receipt")[0] == "denied", field
            restore()
        client.command("HSET", receipt_key, "extra", "field")
        assert call(acc, "accepted-receipt", "receipt")[0] == "denied"; restore()
        client.command("PERSIST", receipt_key)
        assert call(acc, "accepted-receipt", "receipt")[0] == "denied"; restore()
        client.command("PEXPIREAT", receipt_key, absolute + 1)
        assert call(acc, "accepted-receipt", "receipt")[0] == "denied"; restore()
        future = redis_now() + 60_000
        client.command("HSET", receipt_key, "acceptedAt", future, "expiresAt", future + 35 * 86_400_000)
        client.command("PEXPIREAT", receipt_key, future + 35 * 86_400_000)
        assert call(acc, "accepted-receipt", "receipt")[0] == "denied"; restore()
        client.command("PEXPIREAT", receipt_key, redis_now())
        assert call(acc, "accepted-receipt", "receipt")[0] == "denied"
        print("PASS: read-only accepted receipt checks account/intent/payload/units/provenance/state/exact TTL/Redis TIME, without refreshing")

        acc = account(); initialize(acc)
        legacy = call(acc, "legacy-no-fingerprint", payload="")
        claim_call(acc, "legacy-no-fingerprint", legacy, "dispatch", payload="")
        assert claim_call(acc, "legacy-no-fingerprint", legacy, "settle", "accepted", payload="")[0] == "settled"
        assert call(acc, "legacy-no-fingerprint", "receipt")[0] == "denied"
        # Equal bodies with distinct intent nonces are independent permissions.
        acc = account(); initialize(acc, cap=2)
        one = call(acc, "nonce-one", cap=2); two = call(acc, "nonce-two", cap=2)
        assert one[0] == two[0] == "reserved"
        assert claim_call(acc, "nonce-one", one, "dispatch")[0] == "dispatch"
        assert claim_call(acc, "nonce-two", two, "dispatch")[0] == "dispatch"
        assert dispatches[(acc, "nonce-one", one[1])] != dispatches[(acc, "nonce-two", two[1])]
        print("PASS: legacy claims have no accepted payload receipt; equal payloads with distinct intent nonces never merge permissions")

        acc = account(); initialize(acc)
        saved = call(acc, "server-clock")
        assert claim_call(acc, "server-clock", saved, "dispatch", now=redis_now() - 2_000) == ["denied", "expired"]
        assert client.command("HGET", keys(acc, "server-clock")[1], "state") == "reserved"
        past = redis_now() - 1
        assert call(acc, "expired-source", now=past - 1000, until=past, observed=past - 1000) == ["denied", "arguments"]
        print("PASS: worker/Redis clock disagreement cannot create expired dispatch permission or a past-horizon reservation")

        for outcome, before_release, expected_spent in [("accepted", False, 0), ("accepted", True, 1), ("confirmed_not_accepted", True, 0)]:
            acc = account(); initialize(acc)
            saved = call(acc, "partial-settlement")
            claim_call(acc, "partial-settlement", saved, "dispatch")
            needle = "redis.call('HINCRBY',KEYS[1],'held',-units)\nreturn {'settled',outcome}" if before_release else "redis.call('PEXPIREAT',KEYS[2],expiry)\nif outcome=='accepted'"
            assert script.count(needle) == 1
            interrupted = script.replace(needle, "error('synthetic settlement interruption'); " + needle, 1)
            try:
                claim_call(acc, "partial-settlement", saved, "settle", outcome, lua_override=interrupted)
                raise AssertionError("Expected injected Redis script error")
            except RuntimeError as error:
                assert "synthetic settlement interruption" in str(error)
            assert [int(x) for x in client.command("HMGET", keys(acc, "partial-settlement")[0], "spent", "held")] == [expected_spent, 1]
            again = claim_call(acc, "partial-settlement", saved, "settle", outcome)
            assert again == (["already_settled", outcome] if before_release else ["denied", "claim_shape"]), again
            assert [int(x) for x in client.command("HMGET", keys(acc, "partial-settlement")[0], "spent", "held")] == [expected_spent, 1]
        print("PASS: interrupted Lua settlement can over-reserve but cannot free another attempt or erase accepted spend")

        acc = account(); initialize(acc, used=2)
        assert call(acc, "regressed-count", used=1) == ["denied", "usage_regressed"]
        assert call(acc, "regressed-clock", used=2, observed=anchor - 1) == ["denied", "usage_regressed"]
        # Cross an actual short fixture boundary rather than forge Redis time.
        acc = account()
        old_reset = redis_now() + 500
        old_start = old_reset - 31 * 86_400_000
        initialize(acc, used=2, period_start=old_start, period_reset=old_reset)
        first = call(acc, "accepted-before-reset", used=2, units=2, period_start=old_start, period_reset=old_reset)
        claim_call(acc, "accepted-before-reset", first, "dispatch")
        assert claim_call(acc, "accepted-before-reset", first, "settle", "accepted") == ["settled", "accepted"]
        pending = call(acc, "pending-reset", used=2, units=3, period_start=old_start, period_reset=old_reset)
        claim_call(acc, "pending-reset", pending, "dispatch")
        claim_call(acc, "pending-reset", pending, "settle", "unknown")
        while redis_now() <= old_reset:
            time.sleep(0.01)
        next_now = redis_now()
        next_period = dict(now=next_now, period_start=old_reset, period_reset=old_reset + 30 * 86_400_000, used=4)
        assert call(acc, "new-no-proof", **next_period) == ["denied", "unreviewed_reset"]
        assert int(client.command("HGET", keys(acc, "new-no-proof")[0], "spent")) == 2
        assert call(acc, "new-with-proof", prior=[old_start, old_reset, 5, old_reset], **next_period)[0] == "reserved"
        assert [int(x) for x in client.command("HMGET", keys(acc, "new-with-proof")[0], "seenUsed", "spent", "held")] == [4, 0, 4]
        assert claim_call(acc, "pending-reset", pending, "settle", "accepted") == ["settled", "accepted"]
        assert [int(x) for x in client.command("HMGET", keys(acc, "new-with-proof")[0], "spent", "held")] == [3, 1]
        print("PASS: only a reviewed consecutive provider period resets settled spend; unresolved holds carry over")

        acc = account()
        assert call(acc, "bootstrap", "initialize", cap=50_001) == ["denied", "arguments"]
        initialize(acc)
        ledger = keys(acc, "bounded")[0]
        client.command("HSET", ledger, "attempts", 50_000)
        assert call(acc, "bounded") == ["denied", "attempt_capacity"]
        client.command("EXPIRE", ledger, 10)
        assert call(acc, "expired-ledger") == ["denied", "ledger_shape"]
        wrong = account(); ledger = keys(wrong, "wrong")[0]
        client.command("SET", ledger, "synthetic wrong type")
        assert call(wrong, "wrong") == ["denied", "ledger_shape"]
        assert client.command("GET", ledger) == "synthetic wrong type"
        print("PASS: malformed/expiring state, oversized caps and unlimited refusal tombstones cannot authorize fallback")

        delayed_clock_authorization()

        measured = account()
        def measured_commands(work):
            at = redis_now()  # Fixture clock read is outside the measured path.
            before = stats(); work(at); after = stats()
            return sum(after.get(key, 0) - before.get(key, 0) for key in set(before) | set(after) if key != "info")
        counts = {"initialize": measured_commands(lambda at: initialize(measured, now=at))}
        saved_box = []
        counts["reserve"] = measured_commands(lambda at: saved_box.append(call(measured, "measured", now=at)))
        saved = saved_box[0]
        counts["dispatch"] = measured_commands(lambda at: claim_call(measured, "measured", saved, "dispatch", now=at))
        counts["settle_accepted"] = measured_commands(lambda at: claim_call(measured, "measured", saved, "settle", "accepted", now=at))
        counts["read_accepted"] = measured_commands(lambda at: call(measured, "measured", "receipt", now=at))
        canceled = call(measured, "measured-cancel")
        counts["cancel_reserved"] = measured_commands(lambda at: claim_call(measured, "measured-cancel", canceled, "cancel", now=at))
        print(json.dumps({"observed_redis_commands_including_eval_and_redis_call": counts, "supplier_invoice": False}))
        assert counts == {"initialize": 4, "reserve": 11, "dispatch": 11, "settle_accepted": 14, "read_accepted": 10, "cancel_reserved": 13}, counts
        print("PASS: exact application Lua, atomicity and observed Redis command counts")
    finally:
        try:
            cleanup = Redis(port)
            try:
                for key in touched:
                    cleanup.command("DEL", key)
            finally:
                cleanup.close()
        finally:
            client.close()
            if owned:
                owned.terminate()
                owned.wait(timeout=10)
            temp.cleanup()
            print("CLEANUP: only synthetic keys removed; owned loopback Redis stopped without persistence")


if __name__ == "__main__":
    main()
