/**
 * CX-123 rule 24, lot L7 (Claude 4 on #2714): putting a paid order on the creator's list (lib/buyer-list.ts) decides
 * from Redis marks whether the order is already there and whether this run is the one doing it. A mark answered in an
 * unknown shape is never "not on the list yet" nor "ours": nothing is done on it this run, the run says it failed, and
 * the next run, on a whole reading, does it once. Replies the stand-in never gives by itself are injected for one
 * command only, after it ran (or instead of it, for a write that did not land).
 */
import { orderWriteCharged } from "@/lib/order-data";
import { listOrder, listedAlready } from "@/lib/buyer-list";
import { leadsKey, parseContact } from "@/lib/contacts";
import { sweepCheckouts } from "@/lib/checkout-sweep";
import { addProduct, claimHandle, ensureListId, ensureStatsId, setMailSettings, setProductLink, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";
import { installSesMailFixture } from "./ses-mail-fixture";

let sessions: unknown = [];
const mail = installSesMailFixture({
  fallback: (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/v1/checkout/sessions") return new Response(JSON.stringify({ object: "list", data: sessions, has_more: false }));
    return new Response(JSON.stringify({ object: "list", data: [], has_more: false }));
  },
});

/** The reply to the first pipeline whose first command is `name` on a key starting `prefix`, replaced after it ran. */
async function withReply(name: string, prefix: string, reply: (real: unknown) => unknown, run: () => Promise<unknown>, landed = true): Promise<void> {
  const real = redis.pipeline.bind(redis);
  let used = false;
  redis.pipeline = (async (commands: (string | number)[][]) => {
    if (!used && commands[0]?.[0] === name && String(commands[0]?.[1] ?? "").startsWith(prefix)) {
      used = true;
      const answer = landed ? await real(commands) : undefined;
      return reply(answer);
    }
    return real(commands);
  }) as typeof redis.pipeline;
  try {
    await run();
  } finally {
    redis.pipeline = real;
  }
}

async function main(): Promise<void> {
  redis.clear();
  mail.configure();
  await mail.setReady(true, { max24: 50_000, rate: 100 });
  process.env.STRIPE_SECRET_KEY = "sk_test_conditions_only_a_stand_in";
  process.env.RESEND_API_KEY = "re_test_conditions_only_a_stand_in";

  const OWNER = "l7-list@example.com";
  await claimHandle(OWNER, "lsevenlist", "Harbor Kitchen", "");
  await ensureStatsId(OWNER);
  await ensureListId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestLsevList1", true);
  await setSubscription(OWNER, { customerId: "cus_LsevList01", subscriptionId: "sub_LsevList01", active: true, tier: "pro", period: paidPeriod() });
  await setMailSettings(OWNER, { fromName: "Harbor Kitchen", address: "1 Main St, Portland, OR 97201" });
  const course = await addProduct(OWNER, "Weeknight Course", "Thirty dinners.", "49", null);
  if (!course.ok) throw new Error("no product");
  await setProductLink(OWNER, course.product.id, "https://example.com/course");
  const store = (await storeForEmail(OWNER))!;
  const order = (id: string, email: string) => ({ sessionId: id, email, news: true, created: Math.floor(Date.now() / 1000), products: [{ id: course.product.id, title: "Weeknight Course" }] });

  part("Already on the list? Only an exact 0 or 1 says");
  redis.run(["SET", "nl:listed:cs_test_lsevenlisted0000001", "done"]);
  const ids = ["cs_test_lsevenlisted0000001", "cs_test_lsevennotyet00000001"];
  is("an exact reading", await listedAlready(ids), [true, false]);
  let read: (boolean | null)[] = [];
  await withReply("EXISTS", "nl:listed:", () => [1, undefined], async () => (read = await listedAlready(ids)));
  is("a reply missing for one: that one is unknown", read, [true, null]);
  await withReply("EXISTS", "nl:listed:", () => ["1", 0], async () => (read = await listedAlready(ids)));
  is("a count as text: unknown", read, [null, false]);
  await withReply("EXISTS", "nl:listed:", (real) => [...(real as unknown[]), 0], async () => (read = await listedAlready(ids)));
  is("more replies than were asked: all unknown", read, [null, null]);

  part("Is this run the one putting it on the list? Only OK, or our own value read back");
  let said = "";
  await withReply("SET", "nl:listed:", () => ["QUEUED"], async () => (said = await listOrder(store, order("cs_test_lsevenoddnotland0001", "ann@example.com"))), false);
  is("a claim answered oddly that did not land: nothing done this time", said, "skip");
  said = await listOrder(store, order("cs_test_lsevenoddnotland0001", "ann@example.com"));
  is("the next try does it", said, "done");
  await withReply("SET", "nl:listed:", () => ["QUEUED"], async () => (said = await listOrder(store, order("cs_test_lsevenoddlanded00001", "bob@example.com"))));
  is("a claim answered oddly that did land with our own value: ours, and done", said, "done");
  is("and never twice", await listOrder(store, order("cs_test_lsevenoddlanded00001", "bob@example.com")), "already");

  part("A run that fails lets go only of its own claim (Revisor 1 on #2719)");
  {
    const real = redis.pipeline.bind(redis);
    let tripped = false;
    redis.pipeline = (async (commands: (string | number)[][]) => {
      const first = String(commands[0]?.[1] ?? "");
      if (!tripped && !first.startsWith("nl:listed:")) {
        // This run's claim ran out while it worked, another run took it, and this run then fails.
        tripped = true;
        redis.run(["SET", "nl:listed:cs_test_lsevenslowrun000001", "another-run"]);
        throw new Error("a stand-in failure while putting the order on the list");
      }
      return real(commands);
    }) as typeof redis.pipeline;
    const errors = console.error;
    console.error = () => {};
    try {
      said = await listOrder(store, order("cs_test_lsevenslowrun000001", "dee@example.com"));
    } finally {
      redis.pipeline = real;
      console.error = errors;
    }
    is("the failing run says skip, and the other run's claim is left alone", [said, redis.run(["GET", "nl:listed:cs_test_lsevenslowrun000001"])], ["skip", "another-run"]);
  }

  part("The sweep: a mark it cannot read is not 'not listed', and the run says it failed");
  sessions = [{
    id: "cs_test_lsevensweep00000001", object: "checkout.session", status: "complete", payment_status: "paid", mode: "payment",
    created: Math.floor(Date.now() / 1000) - 600, amount_total: 4900, currency: "usd",
    customer_details: { email: "cy@example.com" }, metadata: { store: "lsevenlist", product: course.product.id, news: "yes" },
  }];
  let counts = { listed: -1, failed: -1 };
  await withReply("EXISTS", "nl:listed:", () => [undefined], async () => (counts = await sweepCheckouts(Date.now() + 20_000)));
  is("unknown: not put on the list this run, and counted as failed", [counts.listed, counts.failed >= 1], [0, true]);
  counts = await sweepCheckouts(Date.now() + 20_000);
  is("the next whole reading puts it on the list, once", counts.listed, 1);
  counts = await sweepCheckouts(Date.now() + 20_000);
  is("and not again", counts.listed, 0);
  part("G independent: an unknown own claim is included in the sweep's failure count");
  sessions = [{
    id:"cs_test_g2719claimunknown0001",object:"checkout.session",status:"complete",payment_status:"paid",mode:"payment",
    created:Math.floor(Date.now()/1000)-600,amount_total:4900,currency:"usd",
    customer_details:{email:"g2719unknown@example.com"},metadata:{store:"lsevenlist",product:course.product.id,news:"yes"},
  }];
  let claimHits=0;
  await withReply("SET","nl:listed:",()=>{claimHits++;return ["QUEUED"];},async()=>{counts=await sweepCheckouts(Date.now()+20_000);},false);
  is("G unknown-claim transport boundary reached",claimHits,1);
  is("G unknown claim performs no contact write",redis.run(["HGET",leadsKey(store.listId!),"g2719unknown@example.com"]),null);
  is("G unknown claim is said failed by the real sweep",counts.failed>=1,true);
  counts=await sweepCheckouts(Date.now()+20_000);
  is("G healthy claim retry lists exactly once",counts.listed,1);
  is("G healthy claim retry really records the product",parseContact(redis.run(["HGET",leadsKey(store.listId!),"g2719unknown@example.com"]))?.ids.includes(course.product.id),true);

  part("G independent: unreadable contact write receipt cannot certify a completed order");
  {
    const id="cs_test_g2719unknownrecord001",email="g2719record@example.com";
    const original=redis.pipeline.bind(redis);
    let recordHits=0;
    redis.pipeline=(async(commands:(string|number)[][])=>{
      const c=commands[0];
      if(!recordHits&&c?.[0]==="EVAL"&&String(c[1]).startsWith("-- marktmorgen:order-write:v1")&&c.includes(leadsKey(store.listId!))){
        recordHits++;
        const n=Number(c[3+Number(c[2])]);
        // The write did NOT land. Exact outer cardinality; unknown charged slot and unknown HSET/INCR results.
        // JSON round-trippable, deliberately not an invented valid HSET acknowledgement.
        return [[null,...Array.from({length:n},()=>null)]];
      }
      return original(commands);
    }) as typeof redis.pipeline;
    let outcome="";
    try{outcome=await listOrder(store,order(id,email));}finally{redis.pipeline=original;}
    is("G unknown-record transport boundary reached",recordHits,1);
    is("G unknown record cannot claim done",outcome,"skip");
    is("G unknown record cannot leave permanent done",redis.run(["GET",`nl:listed:${id}`])==="done",false);
    is("G injected unknown did not write the real contact",redis.run(["HGET",leadsKey(store.listId!),email]),null);
    // Actual MemoryRedis expiry uses Date.now: advance beyond the 120-second working claim, not the 8-day done mark.
    const clock=Date.now;
    let retried="";
    try{const future=clock()+121_000;Date.now=()=>future;retried=await listOrder(store,order(id,email));}finally{Date.now=clock;}
    is("G healthy record retry can finish instead of being deduplicated forever",retried,"done");
    is("G healthy retry really retains the product",parseContact(redis.run(["HGET",leadsKey(store.listId!),email]))?.ids.includes(course.product.id),true);
    is("G confirmed record is processed only once",await listOrder(store,order(id,email)),"already");
  }
  {
    const id="cs_test_g2719knownrecord0001",email="g2719control@example.com";
    is("G complete real record write still finishes",await listOrder(store,order(id,email)),"done");
    is("G complete real write actually retains the product",parseContact(redis.run(["HGET",leadsKey(store.listId!),email]))?.ids.includes(course.product.id),true);
  }
  part("G independent: numeric zero charge cannot make unreadable mutation replies confirmed");
  {
    const id="cs_test_g2719nullacksrecord01",email="g2719nullacks@example.com";
    const original=redis.pipeline.bind(redis);
    let recordHits=0;
    redis.pipeline=(async(commands:(string|number)[][])=>{
      const c=commands[0];
      if(!recordHits&&c?.[0]==="EVAL"&&String(c[1]).startsWith("-- marktmorgen:order-write:v1")&&c.includes(leadsKey(store.listId!))){
        recordHits++;
        const n=Number(c[3+Number(c[2])]);
        // The write did NOT land. Exact outer cardinality; known numeric charge0 but unknown HSET/INCR results.
        // JSON round-trippable, deliberately not an invented valid HSET acknowledgement.
        return [[0,...Array.from({length:n},()=>null)]];
      }
      return original(commands);
    }) as typeof redis.pipeline;
    let outcome="";
    try{outcome=await listOrder(store,order(id,email));}finally{redis.pipeline=original;}
    is("G numeric-charge/unknown-record transport boundary reached",recordHits,1);
    is("G numeric-charge/unknown record cannot claim done",outcome,"skip");
    is("G numeric-charge/unknown record cannot leave permanent done",redis.run(["GET",`nl:listed:${id}`])==="done",false);
    is("G numeric-charge injected unknown did not write the real contact",redis.run(["HGET",leadsKey(store.listId!),email]),null);
    // Actual MemoryRedis expiry uses Date.now: advance beyond the 120-second working claim, not the 8-day done mark.
    const clock=Date.now;
    let retried="";
    try{const future=clock()+121_000;Date.now=()=>future;retried=await listOrder(store,order(id,email));}finally{Date.now=clock;}
    is("G numeric-charge healthy record retry can finish instead of being deduplicated forever",retried,"done");
    is("G numeric-charge healthy retry really retains the product",parseContact(redis.run(["HGET",leadsKey(store.listId!),email]))?.ids.includes(course.product.id),true);
    is("G numeric-charge confirmed record is processed only once",await listOrder(store,order(id,email)),"already");
  }

  part("G independent: integer-valued is not a command-appropriate HSET receipt");
  for(const mode of ["negative-hset", "excess-hset", "sparse-inner"]){
    const id="cs_test_g2719schema"+mode.replaceAll("-","")+"0001",email="g2719-"+mode+"@example.test";
    const base=redis.pipeline.bind(redis);let hits=0,targets=0;let carrier:unknown;
    redis.pipeline=(async(commands:(string|number)[][])=>{
      const c=commands[0];
      if(!hits&&c?.[0]==="EVAL"&&String(c[1]).startsWith("-- marktmorgen:order-write:v1")&&c.includes(leadsKey(store.listId!))){
        hits++;const keys=Number(c[2]),n=Number(c[3+keys]);let at=4+keys;
        const plan:{name:string;argc:number;key:string;args:(string|number)[]}[]=[];
        for(let i=0;i<n;i++){const name=String(c[at]),k=Number(c[at+1]),argc=Number(c[at+2]);plan.push({name,argc,key:String(c[2+k]),args:c.slice(at+3,at+3+argc)});at+=3+argc;}
        targets=plan.filter(p=>p.name==="HSET").length;
        const out:unknown[]=mode==="sparse-inner"?Array(n+1):[0,...plan.map(p=>{
          if(p.name==="HSET")return mode==="negative-hset"?-1:Math.floor(p.argc/2)+1;
          if(p.name==="SET")return "OK";
          if(p.name==="ZINCRBY"||(p.name==="ZADD"&&p.args.includes("INCR")))return "0";
          return 0;
        })];out[0]=0;carrier=[out];
        console.log("G2719_SCHEMA_CARRIER",JSON.stringify({mode,plan:plan.map(p=>({name:p.name,argc:p.argc})),out,ownSlots:Object.keys(out),jsonDense:mode!=="sparse-inner"}));
        // Do NOT run the application EVAL; the whole reply is the only injected boundary, not stored contact state.
        return carrier;
      }
      return base(commands);
    }) as typeof redis.pipeline;
    let outcome="";try{outcome=await listOrder(store,order(id,email));}finally{redis.pipeline=base;}
    is("G "+mode+": real contact write boundary reached",hits,1);
    is("G "+mode+": the actual plan contains HSET",targets>0,true);
    is("G "+mode+": contact was not written by the injected transport",redis.run(["HGET",leadsKey(store.listId!),email]),null);
    is("G "+mode+": invalid mutation evidence cannot certify done",outcome,"skip");
    is("G "+mode+": no permanent done mark",redis.run(["GET",`nl:listed:${id}`])==="done",false);
    const clock=Date.now;let retry="";try{const later=clock()+121_000;Date.now=()=>later;retry=await listOrder(store,order(id,email));}finally{Date.now=clock;}
    is("G "+mode+": a later healthy write can finish",retry,"done");
    is("G "+mode+": healthy retry retains the product",parseContact(redis.run(["HGET",leadsKey(store.listId!),email]))?.ids.includes(course.product.id),true);
    is("G "+mode+": confirmed retry stays deduplicated",await listOrder(store,order(id,email)),"already");
  }

  part("G controls: legitimate command domains and an applied-but-lost mutation receipt");
  {
    const h="nl:g2719:domain:hash",k="nl:g2719:domain:signed",z="nl:g2719:domain:z";
    is("G genuine two-field HSET may add two",(await orderWriteCharged(store,[["HSET",h,"a","one","b","two"]])).replies,[2]);
    is("G actual HSET retained both fields",[redis.run(["HGET",h,"a"]),redis.run(["HGET",h,"b"])],["one","two"]);
    is("G updating an existing HSET field may add zero",(await orderWriteCharged(store,[["HSET",h,"a","updated"]])).replies,[0]);
    await orderWriteCharged(store,[["SET",k,"0"]]);
    is("G a legitimate DECR may be negative",(await orderWriteCharged(store,[["DECR",k]])).replies,[-1]);
    is("G a legitimate HINCRBY may be negative",(await orderWriteCharged(store,[["HINCRBY",h,"signed",-2]])).replies,[-2]);
    is("G a legitimate ZINCRBY may return a negative numeric string",Number((await orderWriteCharged(store,[["ZINCRBY",z,-1,"member"]])).replies[0]),-1);
  }
  {
    const id="cs_test_g2719appliedunknown01",email="g2719-applied-unknown@example.test",input=order("cs_test_g2719appliedunknown01","g2719-applied-unknown@example.test");
    const base=redis.pipeline.bind(redis);let hits=0;
    redis.pipeline=(async(commands:(string|number)[][])=>{
      const c=commands[0];
      if(!hits&&c?.[0]==="EVAL"&&String(c[1]).startsWith("-- marktmorgen:order-write:v1")&&c.includes(leadsKey(store.listId!))){
        hits++;const answer=await base(commands),outer=[...(answer as unknown[])],inner=[...(outer[0] as unknown[])];
        // The REAL application EVAL landed; lose only its HSET mutation acknowledgement.
        inner[1]=null;outer[0]=inner;return outer;
      }
      return base(commands);
    }) as typeof redis.pipeline;
    let outcome="";try{outcome=await listOrder(store,input);}finally{redis.pipeline=base;}
    is("G applied/lost ACK boundary reached",hits,1);
    is("G an applied contact remains present despite its lost ACK",parseContact(redis.run(["HGET",leadsKey(store.listId!),email]))?.ids.includes(course.product.id),true);
    is("G applied/lost ACK is not certified done",outcome,"skip");
    is("G applied/lost ACK leaves no permanent done mark",redis.run(["GET",`nl:listed:${id}`])==="done",false);
    is("G healthy same-intent retry confirms the already-kept contact",await listOrder(store,input),"done");
    is("G applied/lost ACK retry preserves one product identity",parseContact(redis.run(["HGET",leadsKey(store.listId!),email]))?.ids.filter(x=>x===course.product.id).length,1);
  }
  done();
}

void main();
