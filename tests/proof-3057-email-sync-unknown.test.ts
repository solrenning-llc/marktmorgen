/**
 * Proof (review of #3057, rule 30, synthetic): lib/email-sync.ts readConfig reads its GET with
 * `const [raw] = ...; parseConfig(raw)`, so an unknown reply is "no settings". connect() then rebuilds the
 * settings from defaults: the creator's chosen buyers ("some"), products, tags and "free: false" are erased.
 * Local stand-in server only; no real platform is reached.
 */
import { claimHandle, ensureStatsId, storeForEmail } from "@/lib/store";
import { connect } from "@/lib/email-sync";
import { seal } from "@/lib/secret-box";
import { setPlatformHooksForTests } from "@/lib/email-platforms";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import http from "node:http";
import https from "node:https";
import net from "node:net";

process.env.NIMBUS_DATA_KEY ??= "tests-only-not-a-real-deployment-secret";

const server = http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(String(req.url).startsWith("/v4/forms") || String(req.url).includes("/forms") ? JSON.stringify({ forms: [{ id: "form1", name: "Synthetic form" }] }) : JSON.stringify({ account: { name: "x" } }));
});
class LocalAgent extends https.Agent {
  constructor(private port: number) { super({ keepAlive: false }); }
  createConnection(): net.Socket { return net.connect(this.port, "127.0.0.1"); }
}

async function main(): Promise<void> {
  console.error = () => {};
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  setPlatformHooksForTests({ resolve: async () => [{ address: "93.184.216.34", family: 4 }], agent: new LocalAgent((server.address() as net.AddressInfo).port) });
  redis.clear();
  await claimHandle("sync-proof@example.com", "sync-proof-shop", "Sync Proof Shop", "");
  await ensureStatsId("sync-proof@example.com");
  const store = (await storeForEmail("sync-proof@example.com"))!;
  const key = "synthetic_platform_key_000000";
  const saved = {
    handle: store.handle, provider: "kit", key: seal(key, `email-sync|${store.statsId}|kit`), last4: "0000",
    target: { id: "form1", name: "Synthetic form" }, free: false, buyers: "some", products: ["prod_aaaaaaaa"], tags: { prod_aaaaaaaa: ["vip"] },
    since: 1, connectedAt: 1,
  };
  const cfgKey = `nl:esync:cfg:${store.statsId}`;
  await redis.pipeline([["SET", cfgKey, JSON.stringify(saved)]]);

  part("Control: a known read keeps the creator's choices on reconnect");
  const ok = await connect(store, "kit", key);
  const after = JSON.parse(String((await redis.pipeline([["GET", cfgKey]]))[0]));
  is("connected", ok.ok, true);
  is("choices kept", [after.buyers, after.free, after.products, after.tags], ["some", false, saved.products, saved.tags]);

  part("The settings' GET answers in an unknown shape");
  await redis.pipeline([["SET", cfgKey, JSON.stringify(saved)]]);
  const real = redis.pipeline.bind(redis);
  redis.pipeline = (async (c: (string | number)[][]) =>
    c.length === 1 && c[0][0] === "GET" && c[0][1] === cfgKey ? [undefined] : real(c)) as typeof redis.pipeline;
  let threw = false;
  try { await connect(store, "kit", key); } catch { threw = true; }
  redis.pipeline = real;
  const now = JSON.parse(String((await redis.pipeline([["GET", cfgKey]]))[0]));
  is("not done on a guess, or the creator's choices are kept", threw || (now.buyers === "some" && now.free === false && now.products.length === 1), true);
  is("the choices as kept", [now.buyers, now.free, now.products, now.tags], ["some", false, saved.products, saved.tags]);
  setPlatformHooksForTests(undefined);
  server.close();
  done();
}

void main();
