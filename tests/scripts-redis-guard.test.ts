/**
 * The scripts that run journeys against "a Redis" (scripts/security-redis.mjs,
 * scripts/closed-store-redis.mjs, scripts/contact-erasure-redis.mjs) and the
 * measurement in scripts/backup-dump-ratio.py must never reach a Redis that is
 * not the throwaway one their Python wrappers serve on loopback. Before this,
 * security-redis.mjs sent FLUSHDB to whatever UPSTASH_REDIS_REST_URL the shell
 * held, with that token, and ran on even when the flush was not confirmed.
 *
 * Everything here is synthetic: the "remote" Redis is a server in this
 * process that only records what reaches it, and redis-cli is a stand-in on
 * PATH that only records its arguments. Nothing leaves this machine.
 */
import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { done, is, part } from "./check";

const root = process.cwd();

type Seen = { auth: string | null; body: string }[];

/** A stand-in Upstash REST host that records every pipeline and answers with `reply`. */
async function fakeUpstash(reply: (commands: unknown[]) => unknown): Promise<{ server: Server; port: number; seen: Seen }> {
  const seen: Seen = [];
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      seen.push({ auth: request.headers.authorization ?? null, body });
      let commands: unknown[] = [];
      try {
        commands = JSON.parse(body);
      } catch {
        commands = [];
      }
      const out = JSON.stringify(reply(commands));
      response.writeHead(200, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(out) });
      response.end(out);
    });
  });
  await new Promise<void>((accept) => server.listen(0, "127.0.0.1", accept));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no port");
  return { server, port: address.port, seen };
}

/** Runs a command without blocking this process, so the stand-in server can answer it. */
function runChild(command: string, args: string[], env: Record<string, string>): Promise<{ status: number | null; output: string }> {
  return new Promise((accept) => {
    const child = spawn(command, args, { cwd: root, env: env as NodeJS.ProcessEnv, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (output += chunk));
    const timer = setTimeout(() => child.kill("SIGKILL"), 240_000);
    child.on("close", (status) => {
      clearTimeout(timer);
      accept({ status, output });
    });
  });
}

const base = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: process.env.HOME ?? "/tmp" };

/** The scripts and the synthetic token each one's Python wrapper sets. */
const SCRIPTS: { script: string; token: string; args: string[] }[] = [
  { script: "scripts/security-redis.mjs", token: "security-check", args: ["affiliate-book"] },
  { script: "scripts/closed-store-redis.mjs", token: "erasure-check", args: [] },
  { script: "scripts/contact-erasure-redis.mjs", token: "erasure-check", args: [] },
];

const ok = () => [{ result: "OK" }];

async function main(): Promise<void> {
  for (const { script, token, args } of SCRIPTS) {
    part(`${script}: refused before anything is sent anywhere but loopback with the synthetic token`);
    const fake = await fakeUpstash(ok);
    try {
      // The address is loopback here only so this test can see what would be sent;
      // "localhost.example.com" is not loopback, and production's token is not the synthetic one.
      const cases: [string, Record<string, string>][] = [
        ["a host that is not loopback", { UPSTASH_REDIS_REST_URL: `http://localhost.example.com:${fake.port}`, UPSTASH_REDIS_REST_TOKEN: token }],
        ["loopback with a token that is not the synthetic one", { UPSTASH_REDIS_REST_URL: `http://127.0.0.1:${fake.port}`, UPSTASH_REDIS_REST_TOKEN: "PRODUCTION-TOKEN-SYNTHETIC" }],
        ["no Upstash address, only the Vercel KV one", { KV_REST_API_URL: `http://127.0.0.1:${fake.port}`, KV_REST_API_TOKEN: token }],
        ["the Vercel KV address left set beside the loopback one", { UPSTASH_REDIS_REST_URL: `http://127.0.0.1:${fake.port}`, UPSTASH_REDIS_REST_TOKEN: token, KV_REST_API_URL: "https://prod.example.com", KV_REST_API_TOKEN: "PRODUCTION-TOKEN-SYNTHETIC" }],
      ];
      for (const [name, env] of cases) {
        const before = fake.seen.length;
        const run = await runChild(process.execPath, [script, ...args], { ...base, ...env });
        is(`${name}: exits with a failure`, run.status !== 0, true);
        is(`${name}: nothing reaches the Redis`, fake.seen.length - before, 0);
        is(`${name}: says why`, /loopback|synthetic/i.test(run.output), true);
      }
    } finally {
      fake.server.close();
    }
  }

  part("scripts/security-redis.mjs: a flush that is not confirmed stops the run");
  for (const [name, reply] of [
    ["an error", [{ error: "ERR flush refused" }]],
    ["an empty reply", []],
    ["a result that is not OK", [{ result: "QUEUED" }]],
    ["not a list", { result: "OK" }],
  ] as [string, unknown][]) {
    const fake = await fakeUpstash(() => reply);
    try {
      const run = await runChild(process.execPath, ["scripts/security-redis.mjs", "affiliate-book"], {
        ...base,
        UPSTASH_REDIS_REST_URL: `http://127.0.0.1:${fake.port}`,
        UPSTASH_REDIS_REST_TOKEN: "security-check",
      });
      is(`${name}: exits with a failure`, run.status !== 0, true);
      is(`${name}: only the flush was sent, no journey ran on an unconfirmed database`, fake.seen.map((s) => s.body), ['[["FLUSHDB"]]']);
    } finally {
      fake.server.close();
    }
  }

  part("scripts/security-redis.mjs: control, loopback with the synthetic token and a confirmed flush goes on");
  {
    const fake = await fakeUpstash((commands) => (commands.length === 1 && JSON.stringify(commands[0]) === '["FLUSHDB"]' ? ok() : commands.map(() => ({ error: "synthetic" }))));
    try {
      await runChild(process.execPath, ["scripts/security-redis.mjs", "affiliate-book"], {
        ...base,
        UPSTASH_REDIS_REST_URL: `http://127.0.0.1:${fake.port}/`,
        UPSTASH_REDIS_REST_TOKEN: "security-check",
      });
      is("the flush is sent first, with the synthetic token", fake.seen[0], { auth: "Bearer security-check", body: '[["FLUSHDB"]]' });
      is("the journey runs after it", fake.seen.length > 1, true);
    } finally {
      fake.server.close();
    }
  }

  part("scripts/backup-dump-ratio.py: refuses a Redis that holds anything, and never flushes it");
  const bin = mkdtempSync(join(tmpdir(), "fake-redis-cli-"));
  try {
    const log = join(bin, "calls.log");
    const fakeCli = (keyspace: string) =>
      writeFileSync(
        join(bin, "redis-cli"),
        `#!/bin/sh\necho "$*" >> "${log}"\ncase "$*" in\n  *INFO*) printf '${keyspace}' ;;\n  *) echo 1 ;;\nesac\n`,
      );
    fakeCli("# Keyspace\\r\\ndb3:keys=12,expires=0,avg_ttl=0\\r\\n");
    chmodSync(join(bin, "redis-cli"), 0o755);
    const full = await runChild("python3", ["scripts/backup-dump-ratio.py"], { ...base, PATH: `${bin}:${base.PATH}` });
    const calls = readFileSync(log, "utf8");
    is("a Redis with keys in any database: exits with a failure", full.status !== 0, true);
    is("a Redis with keys in any database: no FLUSHALL or FLUSHDB", /FLUSH/.test(calls), false);
    is("a Redis with keys in any database: nothing written", /\b(SET|HSET|SADD|ZADD|RPUSH|PFADD)\b/.test(calls), false);

    writeFileSync(log, "");
    fakeCli("# Keyspace\\r\\n");
    const empty = await runChild("python3", ["scripts/backup-dump-ratio.py"], { ...base, PATH: `${bin}:${base.PATH}` });
    const emptyCalls = readFileSync(log, "utf8");
    is("control, an empty Redis: the measurement runs", empty.status, 0);
    is("control, an empty Redis: it writes its synthetic keys", /\bSET nl:s:10\b/.test(emptyCalls), true);
    is("control, an empty Redis: still no flush", /FLUSH/.test(emptyCalls), false);
  } finally {
    rmSync(bin, { recursive: true, force: true });
  }
  done();
}

void main();
