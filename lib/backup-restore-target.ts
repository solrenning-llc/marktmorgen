/**
 * 273 [BK1]: where a backup is restored for a drill — the owner's own,
 * separate and empty Upstash database, never the live one — as the
 * RestoreTarget that restoreSnapshot (lib/backup-export.ts) writes into.
 * Off until the owner sets BACKUP_RESTORE_REDIS_REST_URL and
 * BACKUP_RESTORE_REDIS_REST_TOKEN. Two guards keep it off the live database:
 * its host is refused when it is the live database's (UPSTASH_REDIS_REST_URL
 * or KV_REST_API_URL, compared by host, whatever the case, port or scheme)
 * or its token is the live token; and nothing is written unless the target
 * answers DBSIZE 0 — the live database is never empty, whatever token or
 * settings the process has. Nothing here creates a database, and nothing
 * calls it yet.
 *
 * Upstash's REST API takes a binary value as the raw body of a POST, appended
 * as the command's last argument (https://upstash.com/docs/redis/features/restapi,
 * "JSON or Binary Value", read 31 October 2026). How Upstash decodes a key
 * written in the path is not documented, so no real key is ever put there:
 * each row is RESTOREd under a temporary name of letters and digits only
 * (POST /restore/<temp>/<ttl>, the DUMP bytes as the body, nothing after the
 * value: no ABSTTL, never REPLACE), then renamed to its real name with
 * RENAMENX in a JSON pipeline, which keeps its end and never replaces a key
 * that is there. The end is sent as the time still left, from this machine's
 * clock just before sending: approximate by the clock's skew and the request's
 * time, not the exact end the export read.
 *
 * A drill that stops partway leaves the restore database partly filled, and a
 * rerun is refused (it is not empty): empty it before trying again. Not yet
 * tried against a real Upstash database: that is the drill itself.
 */
import { randomBytes } from "node:crypto";
import { timed } from "@/lib/fetch-timeout";
import type { RestoreTarget } from "@/lib/backup-export";

export type RestoreTargetConfig = { url: string; token: string };

const TIMEOUT_MS = 10_000;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const env = (name: string) => (process.env[name] ?? "").trim();

/** A setting's host, lowercased, with or without a scheme; "" when it names none. */
function hostOf(value: string): string {
  if (!value) return "";
  try {
    return new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `https://${value}`).hostname.toLowerCase().replace(/\.$/, "");
  } catch {
    return "";
  }
}

/** The owner's restore database; null while either setting is missing, malformed, or the live database's. */
export function restoreTargetConfig(): RestoreTargetConfig | null {
  const raw = env("BACKUP_RESTORE_REDIS_REST_URL");
  const token = env("BACKUP_RESTORE_REDIS_REST_TOKEN");
  if (!raw || token.length < 16) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.pathname.replace(/\/+$/, "") !== "" || url.search || url.hash || url.username || url.password || url.port) return null;
  const host = url.hostname.toLowerCase();
  if (!host.endsWith(".upstash.io")) return null;
  const liveHosts = [env("UPSTASH_REDIS_REST_URL"), env("KV_REST_API_URL")].map(hostOf).filter(Boolean);
  const liveTokens = [env("UPSTASH_REDIS_REST_TOKEN"), env("KV_REST_API_TOKEN")].filter(Boolean);
  if (liveHosts.includes(host) || liveTokens.includes(token)) return null;
  return { url: url.origin, token };
}

type Reply = { result?: unknown; error?: string };

/** The RestoreTarget over Upstash's REST API. */
export function backupRestoreTarget(config: RestoreTargetConfig, now: () => number = Date.now): RestoreTarget {
  const auth = { Authorization: `Bearer ${config.token}` };
  const pipeline = (commands: (string | number)[][]) =>
    timed(TIMEOUT_MS, async (signal) => {
      const response = await fetch(`${config.url}/pipeline`, {
        method: "POST",
        headers: { ...auth, "Content-Type": "application/json" },
        body: JSON.stringify(commands),
        signal,
        cache: "no-store",
        redirect: "error",
      });
      if (!response.ok) throw new Error(`Restore database answered ${response.status}`);
      const replies = (await response.json()) as Reply[];
      if (!Array.isArray(replies) || replies.length !== commands.length) throw new Error("Restore database answered the wrong number of results");
      return replies;
    });
  return {
    exists: async (keys) => {
      const [size, ...each] = await pipeline([["DBSIZE"], ...keys.map((key) => ["EXISTS", key])]);
      // The live database is never empty: nothing is written into one that is not.
      if (size.error || size.result !== 0) throw new Error("The restore database is not empty");
      return each.map((item) => {
        if (item.error || (item.result !== 0 && item.result !== 1)) throw new Error("Restore database could not say whether a key is there");
        return item.result as number;
      });
    },
    restore: async (key, expiresAt, dump) => {
      if (!dump || !BASE64.test(dump)) return false;
      const bytes = new Uint8Array(Buffer.from(dump, "base64"));
      let ttl = 0;
      if (expiresAt !== null) {
        ttl = expiresAt - now();
        if (!Number.isSafeInteger(ttl)) return false;
        // Its end passed while the restore ran (restoreRows keeps only rows alive when it starts):
        // the key would be gone by now, so nothing is written, and it is counted apart.
        if (ttl <= 0) return "skipped";
      }
      const temp = `mmrestore${randomBytes(16).toString("hex")}`;
      try {
        const restored = await timed(TIMEOUT_MS, async (signal) => {
          const response = await fetch(`${config.url}/restore/${temp}/${ttl}`, {
            method: "POST",
            headers: { ...auth, "Content-Type": "application/octet-stream" },
            body: bytes as BodyInit,
            signal,
            cache: "no-store",
            redirect: "error",
          });
          const answer = (await response.json().catch(() => null)) as Reply | null;
          return response.ok && answer?.result === "OK";
        });
        if (!restored) return false;
        const [renamed] = await pipeline([["RENAMENX", temp, key]]);
        if (renamed.result === 1 && !renamed.error) return true;
      } catch {
        // Fall through: the temporary name is removed below if it is there.
      }
      await pipeline([["DEL", temp]]).catch(() => {});
      return false;
    },
  };
}
