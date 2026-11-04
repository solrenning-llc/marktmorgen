/**
 * 273 [BK1]: the restore writer (lib/backup-restore-target.ts): a snapshot
 * written into the owner's separate, empty restore database over Upstash's
 * REST API, against a stand-in (fetch replaced; nothing real is reached).
 * Off until the owner's own BACKUP_RESTORE_REDIS_REST_URL and _TOKEN exist,
 * and never the live database.
 *
 * What fails here:
 *   - on with a setting missing, with the live database's address or token,
 *     with an address that is not https on an Upstash host;
 *   - a key written over (RESTORE never with REPLACE; BUSYKEY is a failure);
 *   - a value sent other than as its own bytes in the raw body, a real key
 *     put in a path (its decoding is not documented), a temporary name left
 *     behind, or an end other than the time still left;
 *   - anything written into a database that is not empty, or the live
 *     database's host accepted in another case, port or scheme;
 *   - a key whose end has passed restored at all, stopping the restore, or
 *     counted as written;
 *   - an error answer, a non-OK result or an unreachable database taken as
 *     written; a redirect followed;
 *   - the whole snapshot not round-tripping through restoreSnapshot.
 */
import { backupRestoreTarget, restoreTargetConfig } from "@/lib/backup-restore-target";
import { restoreSnapshot } from "@/lib/backup-export";
import type { BackupSnapshot } from "@/lib/backup-codec";
import { done, is, part } from "./check";

type Call = { method: string; url: string; headers: Record<string, string>; body: Uint8Array | string | null };
const calls: Call[] = [];
const db = new Map<string, { dump: Uint8Array; ttl: number }>();
let answer: { status: number; body: unknown } | null = null;
let extraKeys = 0;
let failRename = false;
const pathKeys: string[] = [];
let down = false;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const method = init?.method ?? "GET";
  const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]));
  const body = init?.body instanceof Uint8Array ? new Uint8Array(init.body) : typeof init?.body === "string" ? init.body : null;
  calls.push({ method, url: String(input), headers, body });
  if (down) throw new TypeError("fetch failed");
  if (init?.redirect !== "error") return new Response("redirects must be refused", { status: 599 });
  if (answer) return Response.json(answer.body, { status: answer.status });
  if (headers.authorization !== "Bearer restore-token-0000000000") return Response.json({ error: "Unauthorized" }, { status: 401 });
  if (url.pathname === "/pipeline") {
    const commands = JSON.parse(String(body)) as string[][];
    if (failRename && commands.some(([name]) => name === "RENAMENX")) return Response.json({ error: "busy" }, { status: 503 });
    return Response.json(commands.map(([name, key, to]) => {
      if (name === "DBSIZE") return { result: extraKeys + db.size };
      if (name === "EXISTS") return { result: db.has(key) ? 1 : 0 };
      if (name === "DEL") return { result: db.delete(key) ? 1 : 0 };
      if (name === "RENAMENX") {
        if (!db.has(key)) return { error: "ERR no such key" };
        if (db.has(to)) return { result: 0 };
        db.set(to, db.get(key)!);
        db.delete(key);
        return { result: 1 };
      }
      return { error: "ERR unknown" };
    }));
  }
  const [, name, key, ttl, ...rest] = url.pathname.split("/");
  if (name !== "restore" || rest.length || url.search) return Response.json({ error: "ERR syntax" }, { status: 400 });
  // How Upstash decodes a path is not documented: only a name of letters and digits may ever be there.
  if (!/^[A-Za-z0-9]+$/.test(key)) pathKeys.push(key);
  if (db.has(key)) return Response.json({ error: "BUSYKEY Target key name already exists." }, { status: 400 });
  db.set(key, { dump: body as Uint8Array, ttl: Number(ttl) });
  return Response.json({ result: "OK" });
}) as typeof fetch;

const ENV = { BACKUP_RESTORE_REDIS_REST_URL: "https://restore-drill-12345.upstash.io", BACKUP_RESTORE_REDIS_REST_TOKEN: "restore-token-0000000000" };
function setEnv(values: Record<string, string | undefined>): void {
  for (const name of ["BACKUP_RESTORE_REDIS_REST_URL", "BACKUP_RESTORE_REDIS_REST_TOKEN", "UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN", "KV_REST_API_URL", "KV_REST_API_TOKEN"]) delete process.env[name];
  for (const [name, value] of Object.entries(values)) if (value !== undefined) process.env[name] = value;
}
const b64 = (bytes: number[]) => Buffer.from(bytes).toString("base64");
const NOW = 1_792_700_000_000;

async function main(): Promise<void> {
  part("Off until the owner's own restore database is set, and never the live one");
  setEnv({});
  is("nothing set: off", restoreTargetConfig(), null);
  setEnv(ENV);
  is("both set: on", restoreTargetConfig()?.url, "https://restore-drill-12345.upstash.io");
  for (const [what, extra] of [
    ["no address", { BACKUP_RESTORE_REDIS_REST_URL: undefined }],
    ["no token", { BACKUP_RESTORE_REDIS_REST_TOKEN: undefined }],
    ["the live database's address", { UPSTASH_REDIS_REST_URL: "https://restore-drill-12345.upstash.io/" }],
    ["the live address in other case", { UPSTASH_REDIS_REST_URL: "https://Restore-Drill-12345.UPSTASH.IO/" }],
    ["the live address with its port", { UPSTASH_REDIS_REST_URL: "https://restore-drill-12345.upstash.io:443" }],
    ["the live address over http", { UPSTASH_REDIS_REST_URL: "http://restore-drill-12345.upstash.io" }],
    ["the live address without a scheme", { KV_REST_API_URL: "restore-drill-12345.upstash.io" }],
    ["an address with a password", { BACKUP_RESTORE_REDIS_REST_URL: "https://:pw@restore-drill-12345.upstash.io" }],
    ["the live database's address by its other name", { KV_REST_API_URL: "https://restore-drill-12345.upstash.io" }],
    ["the live database's token", { UPSTASH_REDIS_REST_TOKEN: "restore-token-0000000000" }],
    ["the live token by its other name", { KV_REST_API_TOKEN: "restore-token-0000000000" }],
    ["an http address", { BACKUP_RESTORE_REDIS_REST_URL: "http://restore-drill-12345.upstash.io" }],
    ["a host that is not Upstash's", { BACKUP_RESTORE_REDIS_REST_URL: "https://restore.example.com" }],
    ["a host that only ends like Upstash's", { BACKUP_RESTORE_REDIS_REST_URL: "https://evil-upstash.io" }],
    ["an address with a path", { BACKUP_RESTORE_REDIS_REST_URL: "https://restore-drill-12345.upstash.io/x" }],
  ] as [string, Record<string, string | undefined>][]) {
    setEnv({ ...ENV, ...extra });
    is(`with ${what}: off`, restoreTargetConfig(), null);
  }

  part("Each key restored from its own bytes, never over another, with the time still left");
  setEnv(ENV);
  const target = backupRestoreTarget(restoreTargetConfig()!, () => NOW);
  const first = calls.length;
  is("a new key is restored", await target.restore("nl:store:a b/ü%", null, b64([0, 1, 2, 255])), true);
  const sent = calls[first];
  is("as one POST under a temporary name of letters and digits, no end as 0, the value's own bytes as the raw body", [sent.method, /^\/restore\/mmrestore[0-9a-f]{32}\/0$/.test(new URL(sent.url).pathname), sent.headers["content-type"], Array.from(sent.body as Uint8Array)], ["POST", true, "application/octet-stream", [0, 1, 2, 255]]);
  is("never with REPLACE or anything after the value", [/replace/i.test(sent.url), new URL(sent.url).search], [false, ""]);
  is("then renamed to its real name in a JSON pipeline, never over a key", JSON.parse(String(calls[first + 1].body))[0].slice(0, 1).concat(JSON.parse(String(calls[first + 1].body))[0][2]), ["RENAMENX", "nl:store:a b/ü%"]);
  is("the real key holds the bytes, and no temporary name is left", [Array.from(db.get("nl:store:a b/ü%")!.dump), [...db.keys()].filter((k) => k.startsWith("mmrestore"))], [[0, 1, 2, 255], []]);
  is("an end in the future: the milliseconds still left, kept by the rename", [await target.restore("nl:k:ttl", NOW + 90_000, b64([7])), db.get("nl:k:ttl")?.ttl], [true, 90_000]);
  const before = calls.length;
  is("an end passed while restoring: skipped, nothing sent", [await target.restore("nl:k:gone", NOW, b64([7])), calls.length - before, db.has("nl:k:gone")], ["skipped", 0, false]);
  is("a value that is not base64, or empty: refused before sending", [await target.restore("nl:k:bad", null, "not base64!"), await target.restore("nl:k:empty", null, ""), calls.length - before], [false, false, 0]);
  is("a key that is there: not renamed over, a failure, the first kept, the temporary name removed", [await target.restore("nl:store:a b/ü%", null, b64([9])), Array.from(db.get("nl:store:a b/ü%")!.dump), [...db.keys()].filter((k) => k.startsWith("mmrestore"))], [false, [0, 1, 2, 255], []]);
  failRename = true;
  is("a rename that fails: a failure, the temporary name removed", [await target.restore("nl:k:z", null, b64([5])), db.has("nl:k:z"), [...db.keys()].filter((k) => k.startsWith("mmrestore"))], [false, false, []]);
  failRename = false;
  for (const [what, a] of [
    ["an error answer", { status: 500, body: { error: "ERR" } }],
    ["a result that is not OK", { status: 200, body: { result: "QUEUED" } }],
    ["an answer of 401", { status: 401, body: { error: "Unauthorized" } }],
  ] as [string, { status: number; body: unknown }][]) {
    answer = a;
    is(`${what}: not written`, await target.restore("nl:k:x", null, b64([1])), false);
  }
  answer = null;
  down = true;
  is("an unreachable database: not written", await target.restore("nl:k:y", null, b64([1])), false);
  is("and whether keys are there cannot be known: a failure, not none", await target.exists(["nl:k:y"]).then(() => "answered", () => "failed"), "failed");
  down = false;

  part("Whether keys are there: DBSIZE and EXISTS in one pipeline; only an empty database is written into");
  is("a database that is not empty, as the live one never is: a failure", await target.exists(["nl:none"]).then(() => "answered", () => "failed"), "failed");
  db.clear();
  is("an empty one: each key, in order", await target.exists(["nl:a", "nl:none"]), [0, 0]);
  extraKeys = 1;
  is("one stray key, such as a temporary name left by a stopped drill: a failure", await target.exists(["nl:a"]).then(() => "answered", () => "failed"), "failed");
  extraKeys = 0;
  answer = { status: 200, body: [{ result: 0 }] };
  is("an answer of the wrong length is a failure", await target.exists(["a", "b"]).then(() => "answered", () => "failed"), "failed");
  answer = null;

  part("A whole snapshot, through restoreSnapshot, into an empty database");
  db.clear();
  const snapshot: BackupSnapshot = { version: 1, capturedAt: NOW - 1000, rows: [
    { key: "nl:one", dump: b64([1, 1]), expiresAt: null },
    { key: "nl:two", dump: b64([2, 2]), expiresAt: NOW + 5_000 },
    { key: "nl:old", dump: b64([3]), expiresAt: NOW - 1 },
  ] };
  is("written whole, the expired row left out", [await restoreSnapshot(snapshot, target, NOW), [...db.keys()].sort()], [{ ok: true, keys: 2 }, ["nl:one", "nl:two"]]);
  is("a second time: refused before writing anything (the database is not empty)", [await restoreSnapshot(snapshot, target, NOW), db.size], [{ ok: false, reason: "failed", keys: 0 }, 2]);
  db.clear();
  const late = backupRestoreTarget(restoreTargetConfig()!, () => NOW + 10_000);
  is("a row whose end passed during the restore is counted apart, never as written", [await restoreSnapshot(snapshot, late, NOW), [...db.keys()].sort()], [{ ok: true, keys: 1, skipped: 1 }, ["nl:one"]]);
  is("no real key was ever put in a path", pathKeys, []);
  is("every request went to the restore database only, with its token", calls.every((c) => c.url.startsWith("https://restore-drill-12345.upstash.io/")), true);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
