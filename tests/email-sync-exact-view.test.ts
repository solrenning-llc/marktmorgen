import { syncView } from "@/lib/email-sync";
import type { Store } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const statsId = "exactemailsyncview000000000001";
const store = { statsId } as Store;
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

async function view(top: unknown[], rows: unknown[] = []): Promise<unknown> {
  let call = 0;
  (redis as unknown as { pipeline: Pipeline }).pipeline = async () => (call++ === 0 ? top : rows);
  try {
    const found = await syncView(store);
    return { provider: found.connected?.provider ?? null, jobs: found.log.map((item) => item.id) };
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
  is("a sparse envelope is unknown", await view(sparse(3, [[0, config], [2, []]])), "unknown");
  const inherited = sparse<unknown>(3, [[0, config], [2, []]]);
  const inheritedPrototype = Object.create(Array.prototype) as Record<number, unknown>;
  inheritedPrototype[1] = null;
  Object.setPrototypeOf(inherited, inheritedPrototype);
  is("an inherited envelope cell is unknown", await view(inherited), "unknown");
  is("a non-list log reply is unknown", await view([config, null, "not-a-list"]), "unknown");

  part("The job batch must match every requested log row");
  is("a short job batch is unknown, never a partial log", await view([config, null, ids], [job(ids[0])]), "unknown");
  is("a sparse job batch is unknown", await view([config, null, ids], sparse(2, [[0, job(ids[0])]])), "unknown");
  is("an extra job row is unknown", await view([config, null, [ids[0]]], ids.map(job)), "unknown");
  is("a malformed requested job is unknown, never silently omitted", await view([config, null, [ids[0]]], ["not-json"]), "unknown");

  done();
}

void main();
