/** Synthetic transport/ACK boundary for real checkout and worker orchestration.
 * It does not prove Lua or accounting: separate scripts run their exact Lua
 * on official disposable Redis. No real provider is contacted.
 */
import assert from "node:assert/strict";
import { createConnection } from "node:net";
import { addProduct, claimHandle, ensureStatsId, ensureStoreId, setProductShipping, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { readProduct } from "@/lib/catalog";
import { COMMIT_ORDER_CONFIRMATION } from "@/lib/orders";
import { CONFIRMATION_ORIGIN_SCRIPT, CONFIRMATION_PAID_SCRIPT, CONFIRMATION_ERASURE_SCRIPT, type ConfirmationOriginRuntime } from "@/lib/order-confirmation-outbox";
import { SHIPMENT_MAIL_SCRIPT } from "@/lib/shipment-mail-outbox";
import { store as redis } from "./redis-stub";
import { shipmentOutboxFixture, shipmentPolicy } from "./shipment-mail-outbox-fixture";

process.env.NIMBUS_DATA_KEY = "SYNTHETIC_ONLY_CONFIRMATION_ORIGIN_KEY_2026";
globalThis.fetch = async () => { throw Error("No external service is allowed in this proof"); };
export async function physicalPaidFixture() {
  redis.clear();
  const owner = "physical-origin@example.test";
  await claimHandle(owner, "physical-origin", "Original printed store", "");
  await ensureStatsId(owner); await ensureStoreId(owner);
  await setStripeAccount(owner, "acct_TestOrigin01", true);
  const created = Date.now();
  await setSubscription(owner, { customerId: "cus_SyntheticPhysicalOrigin", subscriptionId: "sub_SyntheticPhysicalOrigin", active: true, tier: "creator", period: { start: Math.floor(created / 1000) - 86_400, end: Math.floor(created / 1000) + 20 * 86_400, renews: true } });
  const added = await addProduct(owner, "Original printed book", "The purchased version", "35", null);
  assert.ok(added.ok);
  await setProductShipping(owner, added.product.id, { cents: 500, region: "us", countries: ["US"], note: "Original shipping note" });
  const store = (await storeForEmail(owner))!, product = (await readProduct(store, added.product.id))!;
  let clock = created, lose: string | null = null, sequence = 0;
  let accounting: "committed" | "unknown" = "committed";
  const allCommands: (string | number)[][] = [];
  const now = () => clock + Date.now() - created;
  const ack = shipmentOutboxFixture(), sessions = new Map<string, Record<string, unknown>>();
  const calls: { method: string; account: string; body?: string; key?: string; path: string }[] = [];
  const runtime: ConfirmationOriginRuntime = {
    lifecycle: "active", policy: shipmentPolicy(created), now,
    pipeline: async commands => {
      const answers: unknown[] = [];
      for (const c of commands) {
        allCommands.push(c);
        if (c[0] === "TIME") { answers.push([String(Math.floor(now() / 1000)), String(now() % 1000 * 1000)]); continue; }
        if (c[0] === "EVAL" && c[1] === COMMIT_ORDER_CONFIRMATION) { answers.push(accounting === "committed" ? 1 : -1); continue; }
        if (c[0] === "EVAL" && c[1] === SHIPMENT_MAIL_SCRIPT && c[13] !== "enqueue" && c[13] !== "cancel") {
          const k = c.slice(3,13).map(String), raw = redis.run(["GET", k[0]]);
          const r = raw ? JSON.parse(String(raw)) : null;
          if ([k[8], k[9]].some(key => redis.run(["EXISTS", key])) || c[13] === "claim" && r && (r.next > now() || r.checks >= runtime.policy!.maximumChecks)) { answers.push(["held"]); continue; }
        }
        if (c[0] === "EVAL" && c[1] === CONFIRMATION_ERASURE_SCRIPT) {
          const count=Number(c[2]),k=c.slice(3,3+count).map(String),[op,token,person,statsId]=c.slice(3+count).map(String);
          let answer:unknown[]=["unknown"];
          if(op==="begin") {
            const type=redis.run(["TYPE",k[0]]);
            redis.run(["SET",k[1],token]);
            if(["none","set"].includes(String(type))) {
              const members=type==="none"?[]:redis.run(["SMEMBERS",k[0]]) as string[];
              if(members.length<=10_000 && members.every(id=>/^[a-f0-9]{64}$/.test(id)))answer=["begun",members];
            }
          } else if(op==="finish") {
            if(redis.run(["GET",k[0]])===token){redis.run(["PEXPIRE",k[0],600_000]);answer=["finished"];}else answer=["changed"];
          } else if(op==="mark") {
            const raw=redis.run(["GET",k[0]]);
            if(redis.run(["GET",k[2]])!==token)answer=["changed"];
            else if(!raw)answer=["absent"];
            else {
              const row=JSON.parse(String(raw));
              if(row.statsId!==statsId || redis.run(["GET",k[1]])!==row.sourceValue)answer=["unknown"];
              else if(row.person===person)answer=["matched"];
              else if(!["awaiting_creation","creating","creation_unknown","awaiting_payment"].includes(row.phase))answer=["other"];
              else if(typeof row.erasedPeople==="string" && /^(?:[a-f0-9]{64}){0,64}$/.test(row.erasedPeople) && typeof row.erasureSaturated==="boolean") {
                const markers=row.erasedPeople.match(/.{64}/g)??[];
                if(!markers.includes(person)){if(markers.length===64)row.erasureSaturated=true;else row.erasedPeople+=person;redis.run(["SET",k[0],JSON.stringify(row)]);}
                answer=["marked"];
              }
            }
          }
          if(lose===`erasure-${op}`){lose=null;throw Error("Synthetic erasure mutation committed; ACK lost");}
          answers.push(answer);continue;
        }
        if (c[0] === "EVAL" && c[1] === CONFIRMATION_PAID_SCRIPT) {
          const k = c.slice(3,15).map(String), op=String(c[15]), raw=redis.run(["GET", k[0]]);
          if (raw !== c[16]) { answers.push(["changed"]); continue; }
          const r=JSON.parse(String(raw));
          if ([k[8],k[9],k[11]].some(key => redis.run(["EXISTS", key]))) { answers.push(["held"]); continue; }
          let next: string;
          if (op === "paid") {
            next=String(c[17]); const n=JSON.parse(next);
            if((r.erasedPeople.match(/.{64}/g)??[]).includes(n.person)){answers.push(["erased"]);continue;}
            if(r.erasureSaturated){answers.push(["held"]);continue;}
            if(n.erasedPeople!==r.erasedPeople || n.erasureSaturated!==r.erasureSaturated){answers.push(["unknown"]);continue;}
            redis.run(["SREM",k[4],r.id]); redis.run(["SADD",k[10],n.id]);
          } else if (op === "settlement") {
            if (r.next>now()) { answers.push(["held"]); continue; }
            if (r.checks>=runtime.policy!.maximumChecks) { redis.run(["ZREM",k[2],r.id]); answers.push(["held"]); continue; }
            r.checks++; r.next=now()+60_000; next=JSON.stringify(r);
            if (r.checks>=runtime.policy!.maximumChecks) redis.run(["ZREM",k[2],r.id]);
            else redis.run(["ZADD",k[2],r.next,r.id]);
          } else {
            r.phase="accepted"; r.state="refused"; r.next=now()+60_000; next=JSON.stringify(r);
            if (r.checks<runtime.policy!.maximumChecks) redis.run(["ZADD",k[2],r.next,r.id]);
            else redis.run(["ZREM",k[2],r.id]);
          }
          redis.run(["SET",k[0],next]);
          if (lose === op) { lose=null; throw Error("Synthetic paid mutation committed; ACK lost"); }
          answers.push([op,next]); continue;
        }
        if (c[0] !== "EVAL" || c[1] !== CONFIRMATION_ORIGIN_SCRIPT) { answers.push(...await ack.pipeline([c])); continue; }
        const k = c.slice(3, 13).map(String), op = String(c[13]), expected = String(c[14]);
        const raw = redis.run(["GET", k[0]]) as string | null;
        let answer: unknown = ["unknown"];
        if (raw !== expected) answer = ["changed"];
        else if (raw) {
          const r = JSON.parse(raw);
          if (op === "create" && !r.session && r.leaseUntil <= now() && now() < r.created + 23 * 3_600_000) {
            r.phase = "creating"; r.owner = String(c[17]); r.leaseUntil = now() + 120_000; r.createAttempts++;
            const next = JSON.stringify(r); redis.run(["SET", k[0], next]);
            answer = ["creating", next, String(now()), String(r.created + 23 * 3_600_000)];
          } else if (op === "bind") {
            if (r.session) answer = ["bound", raw];
            else { const next = String(c[15]), n = JSON.parse(next); redis.run(["SET", k[0], next]); redis.run(["SET", k[1], n.sourceValue]); answer = ["bound", next]; }
          } else if (op === "cursor") answer = ["cursor", raw];
          else if (op === "url" && r.session && r.phase === "awaiting_payment" && ["queued", "preparing"].includes(r.state) &&
              redis.run(["GET", k[1]]) === r.sourceValue && redis.run(["EXISTS", k[8]]) === 0 && redis.run(["EXISTS", k[9]]) === 0) {
            const serverNow = now();
            answer = ["url", r.id, r.session, r.bindingFingerprint, String(serverNow), String(Math.min(serverNow + 1000, r.expiresAt))];
          }
        }
        if (lose === op) { lose = null; throw Error("Synthetic lost ACK after durable source mutation"); }
        answers.push(answer);
      }
      return answers;
    },
    provider: async (method, account, path, body, _version, key) => {
      calls.push({ method, account, path, ...(body ? { body: body.toString() } : {}), ...(key ? { key } : {}) });
      if (method === "POST") {
        assert.equal(account, store.stripeAccountId);
        const protectedRows = [...redis.keys()].filter(k => k.startsWith("nl:order-confirmation:row:"));
        const nonce=body!.get("metadata[mm_order_intent]");
        const protectedRowsForRequest=protectedRows.map(k=>JSON.parse(String(redis.run(["GET",k])))).filter(r=>r.nonce===nonce);
        assert.equal(protectedRowsForRequest.length, 1, "each original request has its own protected source and admission before Stripe");
        const r = protectedRowsForRequest[0];
        assert.equal(r.phase, "creating", "POST requires the acknowledged creation checkpoint");
        const metadata = Object.fromEntries([...body!].flatMap(([k, v]) => /^metadata\[/.test(k) ? [[k.slice(9, -1), v]] : []));
        const id = `cs_test_physicalorigin${++sequence}00000001`;
        const session = { object: "checkout.session", id, mode: "payment", status: "open", currency: "usd", created: Math.floor(now() / 1000),
          url: `https://checkout.stripe.com/c/pay/${id}`, metadata,
          line_items: { object: "list", has_more: false, data: [{ quantity: 1, price: { unit_amount: 3500, currency: "usd" } }] } };
        sessions.set(id, session); return session;
      }
      const pathOnly = path.split("?")[0];
      if (pathOnly === "/checkout/sessions") return { object: "list", has_more: false, data: [...sessions.values()] };
      return sessions.get(pathOnly.split("/").at(-1)!) ?? {};
    },
  };
  return { store, product, runtime, calls, sessions, created, commands: allCommands, setAccounting: (value: "committed" | "unknown") => { accounting=value; }, loseShared: ack.loseNext, advance: (ms: number) => { clock = created + ms; }, loseNext: (op: string) => { lose = op; } };
}
export function originId() {
  const key = [...redis.keys()].find(k => k.startsWith("nl:order-confirmation:row:"));
  assert.ok(key); return key.slice("nl:order-confirmation:row:".length);
}


export async function confirmationLocalPipeline(commands:(string | number)[][]):Promise<unknown[]> {
  const port=Number(process.env.CONFIRMATION_ORIGIN_REDIS_PORT);
  if(process.env.MARKTMORGEN_REDIS_INTEGRATION!=="1" || !Number.isInteger(port) || port<1024 || port>65535) throw Error("Dedicated disposable loopback Redis required");
  const encoded=commands.map(c=>`*${c.length}\r\n`+c.map(v=>{const s=String(v);return `$${Buffer.byteLength(s)}\r\n${s}\r\n`;}).join("")).join("");
  return new Promise((resolve,reject)=>{
    const socket=createConnection({host:"127.0.0.1",port});let buffer=Buffer.alloc(0);
    const parse=(start:number):{value:unknown;end:number}|null=>{
      const eol=buffer.indexOf("\r\n",start);if(eol<0)return null;
      const kind=String.fromCharCode(buffer[start]),text=buffer.toString("utf8",start+1,eol),next=eol+2;
      if(kind==="+")return{value:text,end:next};
      if(kind==="-")throw Error(text);
      if(kind===":")return{value:Number(text),end:next};
      if(kind==="$"){const n=Number(text);if(n===-1)return{value:null,end:next};if(buffer.length<next+n+2)return null;return{value:buffer.toString("utf8",next,next+n),end:next+n+2};}
      if(kind==="*"){const n=Number(text);if(n===-1)return{value:null,end:next};const out=[];let cursor=next;for(let i=0;i<n;i++){const item=parse(cursor);if(!item)return null;out.push(item.value);cursor=item.end;}return{value:out,end:cursor};}
      throw Error("Invalid disposable Redis reply");
    };
    socket.setTimeout(5000,()=>socket.destroy(Error("Disposable Redis timed out")));
    socket.on("error",reject);socket.on("connect",()=>socket.write(encoded));
    socket.on("data",chunk=>{buffer=Buffer.concat([buffer,chunk]);try{const replies=[];let cursor=0;for(let i=0;i<commands.length;i++){const item=parse(cursor);if(!item)return;replies.push(item.value);cursor=item.end;}socket.end();resolve(replies);}catch(e){socket.destroy();reject(e);}});
  });
}
