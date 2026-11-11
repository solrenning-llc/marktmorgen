import http from "node:http";
import https from "node:https";
import net from "node:net";
import { connect, disconnect, saveSettings, syncView, testConnection } from "@/lib/email-sync";
import { setPlatformHooksForTests } from "@/lib/email-platforms";
import { seal } from "@/lib/secret-box";
import type { Store } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const statsId = "exactemailsyncview000000000001";
const store = {
  statsId,
  handle: "exact-view",
  email: "exact-view@example.test",
  sid: "11111111111111111111111111111111",
  extra: false,
  catalog: { id: "synthetic", items: [] },
} as unknown as Store;
const config = JSON.stringify({
  handle: "exact-view",
  provider: "kit",
  key: "sealed-test-value",
  last4: "test",
  target: { id: "audience", name: "Synthetic audience" },
  free: true,
  buyers: "all",
  products: [],
  tags: {},
  since: 1,
  connectedAt: 2,
});
const ids = ["esj_111111111111111111111111", "esj_222222222222222222222222"];
const job = (id: string) => JSON.stringify({
  id,
  statsId,
  email: "buyer@example.test",
  firstName: "Dana",
  products: [],
  title: "Synthetic product",
  source: "purchase",
  attempts: 1,
  state: "added",
  next: 0,
  lastError: "",
  note: "Added",
  lastAt: 2,
  createdAt: 1,
});

type Pipeline = (commands: (string | number)[][]) => Promise<unknown[]>;
const original = redis.pipeline.bind(redis) as Pipeline;

const server = http.createServer((request, response) => {
  response.setHeader("Content-Type", "application/json");
  if (request.url === "/v4/account") response.end("{}");
  else if (request.url?.startsWith("/v4/forms?")) response.end(JSON.stringify({ forms: [{ id: "audience", name: "First" }, { id: "second", name: "Second" }], pagination: { has_previous_page: false, has_next_page: false } }));
  else {
    response.statusCode = 404;
    response.end("{}");
  }
});
class LocalAgent extends https.Agent {
  constructor(private port: number) {
    super({ keepAlive: false });
  }
  createConnection(): net.Socket {
    return net.connect(this.port, "127.0.0.1");
  }
}

async function view(top: unknown[], rows: unknown[] = []): Promise<unknown> {
  let call = 0;
  (redis as unknown as { pipeline: Pipeline }).pipeline = async () => (call++ === 0 ? top : rows);
  try {
    const found = await syncView(store);
    return { provider: found.connected?.provider ?? null, jobs: found.log?.map((item) => item.id) ?? "unread" };
  } catch {
    return "unknown";
  } finally {
    (redis as unknown as { pipeline: Pipeline }).pipeline = original;
  }
}

function sparse<T>(length: number, entries: [number, T][]): T[] {
  const value = new Array<T>(length);
  for (const [index, item] of entries) value[index] = item;
  return value;
}

async function attempt<T>(run: () => Promise<T>): Promise<T | "threw"> {
  try {
    return await run();
  } catch {
    return "threw";
  }
}

async function main(): Promise<void> {
  part("A complete view remains readable");
  is("an exact empty log is connected and empty", await view([config, null, []]), { provider: "kit", jobs: [] });
  is("every requested job is returned", await view([config, null, ids], ids.map(job)), { provider: "kit", jobs: ids });
  is("an expired requested job is known absence", await view([config, null, [ids[0]]], [null]), { provider: "kit", jobs: [] });
  is("an expired row does not hide a present job", await view([config, null, ids], [null, job(ids[1])]), {
    provider: "kit",
    jobs: [ids[1]],
  });

  part("The three-part view envelope must be exact and own");
  is("a short envelope is unknown, never disconnected or empty", await view([config]), "unknown");
  is("a sparse envelope is unknown", await view(sparse<unknown>(3, [[0, config], [2, []]])), "unknown");
  const inherited = sparse<unknown>(3, [[0, config], [2, []]]);
  const inheritedPrototype = Object.create(Array.prototype) as Record<number, unknown>;
  inheritedPrototype[1] = null;
  Object.setPrototypeOf(inherited, inheritedPrototype);
  is("an inherited envelope cell is unknown", await view(inherited), "unknown");
  is("a non-list log reply marks only the log unread", await view([config, null, "not-a-list"]), { provider: "kit", jobs: "unread" });
  for (const invalid of [42, true, { provider: "kit" }]) {
    is("a non-text configuration cell is unknown", await view([invalid, null, []]), "unknown");
  }
  is("a non-text problem cell is unknown", await view([config, 7, []]), "unknown");
  is("an absent configuration is known absence", await view([null, null, []]), { provider: null, jobs: [] });

  part("The job batch must match every requested log row");
  is("a short job batch marks the log unread, never partial", await view([config, null, ids], [job(ids[0])]), { provider: "kit", jobs: "unread" });
  is("a sparse job batch marks the log unread", await view([config, null, ids], sparse(2, [[0, job(ids[0])]])), { provider: "kit", jobs: "unread" });
  is("an extra job row marks the log unread", await view([config, null, [ids[0]]], ids.map(job)), { provider: "kit", jobs: "unread" });
  is("a malformed requested job marks the log unread, never silently omitted", await view([config, null, [ids[0]]], ["not-json"]), { provider: "kit", jobs: "unread" });

  part("An unread log never blocks the four settings actions");
  redis.clear();
  process.env.NIMBUS_DATA_KEY = "synthetic-email-sync-exact-view-key-2026";
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as net.AddressInfo).port;
  setPlatformHooksForTests({
    resolve: async () => [{ address: "93.184.216.34", family: 4 }],
    agent: new LocalAgent(port) as never,
  });
  const key = "kit_synthetic_exact_view_key_123456";
  const held = JSON.parse(config) as Record<string, unknown>;
  held.key = seal(key, `email-sync|${statsId}|kit`);
  redis.run(["SET", `nl:esync:cfg:${statsId}`, JSON.stringify(held)]);
  redis.run(["LPUSH", `nl:esync:log:${statsId}`, ids[0]]);
  redis.run(["SET", `nl:esync:j:${ids[0]}`, "not-json"]);
  try {
    const connected = await attempt(() => connect(store, "kit", key));
    is("connect succeeds and marks only its log unread", connected !== "threw" && connected.ok ? [connected.view.connected?.provider, connected.view.log] : connected, ["kit", null]);
    const saved = await attempt(() => saveSettings(store, { target: "second", free: true, buyers: "all", products: [], tags: {} }));
    is("choosing a destination succeeds and marks only its log unread", saved !== "threw" && saved.ok ? [saved.view.connected?.target?.id, saved.view.log] : saved, ["second", null]);
    const tested = await attempt(() => testConnection(store));
    is("testing succeeds and marks only its log unread", tested === "threw" ? tested : [tested.ok, tested.view.connected?.target?.id, tested.view.log], [true, "second", null]);
    const removed = await attempt(() => disconnect(store));
    is("disconnecting succeeds without reading the malformed job", removed === "threw" ? removed : [removed.connected, removed.log], [null, null]);

    part("A completed write survives an unavailable follow-up view (C5 #2824)");
    const cfgKey = `nl:esync:cfg:${statsId}`;
    const badKey = `nl:esync:bad:${statsId}`;
    for (const action of ["connect", "save", "test", "missing-target"] as const) {
      redis.clear();
      const seeded = { ...held, target: action === "missing-target" ? { id: "missing", name: "Missing" } : held.target };
      redis.run(["SET", cfgKey, JSON.stringify(seeded)]);
      redis.run(["SET", badKey, JSON.stringify({ message: "Previous problem", at: 1 })]);
      let viewReads = 0;
      (redis as unknown as { pipeline: Pipeline }).pipeline = async (commands) => {
        if (commands.length === 3 && commands[0][0] === "GET" && commands[0][1] === cfgKey && commands[2][0] === "LRANGE") {
          viewReads += 1;
          return [redis.run(["GET", cfgKey])];
        }
        return original(commands);
      };
      try {
        const result = await attempt(async () => {
          if (action === "connect") return connect(store, "kit", key);
          if (action === "save") return saveSettings(store, { target: "second", free: false, buyers: "all", products: [], tags: {} });
          return testConnection(store);
        });
        const expectedTarget = action === "save" ? "second" : action === "missing-target" ? "missing" : "audience";
        is(`${action}: the confirmed action keeps its result and saved connection`,
          result !== "threw" && "view" in result ? [result.ok, result.view.connected?.provider, result.view.connected?.target?.id, result.view.log] : result,
          [action !== "missing-target", "kit", expectedTarget, null]);
        const persisted = JSON.parse(String(redis.run(["GET", cfgKey]))) as { target: { id: string }; free: boolean };
        is(`${action}: the written setting remains persisted`, [persisted.target.id, persisted.free], [expectedTarget, action !== "save"]);
        is(`${action}: an unavailable view is not blindly retried`, viewReads, 1);
        if (action === "missing-target") {
          is("the negative platform test retains its confirmed problem", String(redis.run(["GET", badKey])).includes("not there anymore"), true);
        } else if (action === "connect" || action === "test") {
          is(`${action}: the confirmed problem clear remains applied`, redis.run(["GET", badKey]), null);
        }
      } finally {
        (redis as unknown as { pipeline: Pipeline }).pipeline = original;
      }
    }
  } finally {
    setPlatformHooksForTests(undefined);
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }

  done();
}

void main();
