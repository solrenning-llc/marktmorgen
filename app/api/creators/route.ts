import type { NextRequest } from "next/server";
import {
  CONSENT_VERSION,
  LIMITS,
  PLATFORMS,
  PROBLEM_MIN_LENGTH,
  type CreatorAnswer,
} from "@/lib/creator-research";
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { UnknownReplyError, countOf, repliesFor } from "@/lib/redis-reply";
import { fromAnotherSite, limited } from "@/lib/request-guard";

import { RESPONSES_KEY } from "@/lib/creator-research-store";
import { RESEARCH_ANSWER_MAX_BYTES, RESEARCH_MAX_ANSWERS, answerBytes } from "@/lib/creator-research-room";
const RATE_LIMIT = 5;
const RATE_WINDOW_SECONDS = 60 * 60;
const MAX_BODY_BYTES = 20_000;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

type Field = keyof typeof LIMITS | "platform" | "consentResearch";

function fail(status: number, error: string, field?: Field) {
  return Response.json({ ok: false, error, field }, { status });
}

function readText(
  body: Record<string, unknown>,
  key: keyof typeof LIMITS,
): string | null {
  const value = body[key];
  if (value === undefined || value === null) return "";
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > LIMITS[key] ? null : trimmed;
}

async function hashIp(ip: string): Promise<string> {
  const data = new TextEncoder().encode(`nimbus-creators:${ip}`);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 32);
}

export async function POST(request: NextRequest) {
  // Only accept submissions sent from this site.
  // Refused before anything else is read: another site, by Origin or by
  // Sec-Fetch-Site (lib/request-guard.ts).
  if (fromAnotherSite(request)) return fail(403, "forbidden");

  const length = Number(request.headers.get("content-length") ?? "0");
  if (length > MAX_BODY_BYTES) return fail(413, "too_large");

  let body: Record<string, unknown>;
  try {
    const parsed: unknown = await (await limited(request, MAX_BODY_BYTES)).json();
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return fail(400, "invalid");
    }
    body = parsed as Record<string, unknown>;
  } catch {
    return fail(400, "invalid");
  }

  // Honeypot: real people never see or fill this field.
  if (typeof body.website === "string" && body.website.trim() !== "") {
    return Response.json({ ok: true }, { status: 201 });
  }

  const name = readText(body, "name");
  if (!name) return fail(400, "invalid", "name");

  const email = readText(body, "email");
  if (!email || !EMAIL_PATTERN.test(email)) {
    return fail(400, "invalid", "email");
  }

  const platform = body.platform;
  if (
    typeof platform !== "string" ||
    !(PLATFORMS as readonly string[]).includes(platform)
  ) {
    return fail(400, "invalid", "platform");
  }

  const link = readText(body, "link");
  if (link === null) return fail(400, "invalid", "link");

  const country = readText(body, "country");
  if (!country) return fail(400, "invalid", "country");

  const problem = readText(body, "problem");
  if (!problem || problem.length < PROBLEM_MIN_LENGTH) {
    return fail(400, "invalid", "problem");
  }

  const tools = readText(body, "tools");
  if (tools === null) return fail(400, "invalid", "tools");

  const cost = readText(body, "cost");
  if (cost === null) return fail(400, "invalid", "cost");

  if (body.consentResearch !== true) {
    return fail(400, "consent_required", "consentResearch");
  }
  const consentFollowUp = body.consentFollowUp === true;
  const consentUpdates = body.consentUpdates === true;

  if (!isRedisConfigured()) return fail(503, "unavailable");

  const ip =
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    request.headers.get("x-real-ip") ||
    "unknown";
  const rateKey = `nl:rl:creators:${await hashIp(ip)}`;

  const answer: CreatorAnswer & {
    id: string;
    createdAt: string;
    consentVersion: string;
  } = {
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    name,
    email,
    platform: platform as CreatorAnswer["platform"],
    link,
    country,
    problem,
    tools,
    cost,
    consentResearch: true,
    consentFollowUp,
    consentUpdates,
    consentVersion: CONSENT_VERSION,
  };

  // The answer as it is kept, measured before anything is written (lib/creator-research-room.ts).
  const row = JSON.stringify(answer);
  if (answerBytes(row) > RESEARCH_ANSWER_MAX_BYTES) return fail(413, "too_large");

  try {
    const both = repliesFor(
      await redisPipeline([
        ["SET", rateKey, "0", "EX", RATE_WINDOW_SECONDS, "NX"],
        ["INCR", rateKey],
      ]),
      2,
    );
    // A count not read in its exact shape keeps nothing and is never said as too many (CX-123 rule 24).
    const count = both && (both[0] === "OK" || both[0] === null) ? countOf(both[1]) : null;
    if (count === null || count < 1) throw new UnknownReplyError("the creator research count");
    if (count > RATE_LIMIT) return fail(429, "rate_limited");

    // The list's ceiling, read before the write: a count not read exactly keeps nothing (CX-123 rule 24).
    const held = repliesFor(await redisPipeline([["LLEN", RESPONSES_KEY]]), 1);
    const answers = held ? countOf(held[0]) : null;
    if (answers === null) throw new UnknownReplyError("the creator research answers held");
    if (answers >= RESEARCH_MAX_ANSWERS) return fail(503, "full");

    const [saved] = await redisPipeline([["LPUSH", RESPONSES_KEY, row]]);
    if (typeof saved !== "number" || !Number.isSafeInteger(saved) || saved < 1) {
      throw new Error("Research storage did not confirm the saved answer");
    }
    // Another answer kept between the read and the write: the one the write finds past the ceiling takes itself back
    // (its row is its own, by its random id), so the list never stays past it. Taken back only on an exact 1.
    if (saved > RESEARCH_MAX_ANSWERS) {
      const back = repliesFor(await redisPipeline([["LREM", RESPONSES_KEY, 1, row]]), 1);
      if (!back || back[0] !== 1) throw new UnknownReplyError("taking back a creator research answer past the ceiling");
      return fail(503, "full");
    }
  } catch (error) {
    console.error("creator research submission failed", error);
    return fail(500, "server_error");
  }

  return Response.json({ ok: true, saved: true }, { status: 201 });
}
