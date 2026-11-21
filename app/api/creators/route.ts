import type { NextRequest } from "next/server";
import { windowCount, windowCountOf } from "@/lib/window-count";
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
import { visitorAddress } from "@/lib/traffic-rules";

import { RESPONSES_KEY } from "@/lib/creator-research-store";
import { KEEP_RESEARCH_ANSWER, RESEARCH_ANSWERS_PER_DAY, RESEARCH_ANSWER_MAX_BYTES, RESEARCH_MAX_ANSWERS, answerBytes } from "@/lib/creator-research-room";
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
  // Per connection, never per raw address: an IPv6 host holds a whole /64, and each of its addresses would otherwise
  // get its own five (Claude 7 on #3584: one /64 filled the list's 320 in seconds).
  const rateKey = `nl:rl:creators:${await hashIp(visitorAddress(ip))}`;
  // Everyone's new answers in one UTC day, under RESEARCH_ANSWERS_PER_DAY, so rotating connections can never fill the
  // list (lib/creator-research-room.ts). Two days kept, so the day's count outlives the day it counts.
  const dayKey = `nl:rl:creators:day:${new Date().toISOString().slice(0, 10)}`;

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
    // A count not read in its exact shape keeps nothing and is never said as too many (CX-123 rule 24).
    const count = windowCountOf(await redisPipeline(windowCount(rateKey, RATE_WINDOW_SECONDS)));
    if (count === null || count < 1) throw new UnknownReplyError("the creator research count");
    if (count > RATE_LIMIT) return fail(429, "rate_limited");
    // The day's count, read in its exact shape too: unread is never "room left" (CX-123 rule 24).
    const today = windowCountOf(await redisPipeline(windowCount(dayKey, 2 * 86_400)));
    if (today === null || today < 1) throw new UnknownReplyError("the creator research day's count");
    if (today > RESEARCH_ANSWERS_PER_DAY) {
      // Told to the owner (the log is read by the error alerts): more than a day's real answers came in.
      if (today === RESEARCH_ANSWERS_PER_DAY + 1) console.error(`creator research: today's cap of ${RESEARCH_ANSWERS_PER_DAY} new answers was reached; later answers today are refused as busy`);
      return fail(429, "busy");
    }

    // The list's ceiling and the write in one step (lib/creator-research-room.ts): answers sent at once, a lost
    // reply or a failed step never leave it past the ceiling. Only 0 is full and only a length inside the
    // ceiling is saved; any other reply is not a confirmation (CX-123 rule 24).
    const kept = repliesFor(await redisPipeline([["EVAL", KEEP_RESEARCH_ANSWER, 1, RESPONSES_KEY, RESEARCH_MAX_ANSWERS, row]]), 1);
    const length = kept ? countOf(kept[0]) : null;
    if (length === 0) {
      // A full list needs the owner's decision (export, then clear): said in the log every time it refuses one.
      console.error(`creator research: the list is full (${RESEARCH_MAX_ANSWERS} answers); an answer was refused`);
      return fail(503, "full");
    }
    if (length === null || length > RESEARCH_MAX_ANSWERS) {
      throw new UnknownReplyError("keeping a creator research answer");
    }
  } catch (error) {
    console.error("creator research submission failed", error);
    return fail(500, "server_error");
  }

  return Response.json({ ok: true, saved: true }, { status: 201 });
}
