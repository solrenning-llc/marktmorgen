import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { NextRequest } from "next/server";
import { POST } from "@/app/api/privacy/do-not-contact/route";
import {
  DO_NOT_CONTACT_KEY,
  DO_NOT_CONTACT_PUBLIC_KEY,
  RESEARCH_DO_NOT_CONTACT_MAX,
  RESEARCH_DO_NOT_CONTACT_PUBLIC_MAX,
  RESEARCH_STOP_PER_HOUR,
  addToDoNotContact,
  normalizeResearchContact,
} from "@/lib/research-do-not-contact";
import { store as redis } from "./redis-stub";

// The pre-review of the research do-not-contact list (owner's decision 13,
// 9 November 2026) found it told who is on the list once it was full, could
// lose a place for good, let one IPv6 network fill it, kept the same address
// apart when written another common way, kept more bytes than its registry
// line says, and that the privacy policy promised a check before research
// messages that nothing sends. Each test here held the defect.

const root = process.cwd();
const OLD_COUNT_KEY = "nl:research:dnc:n";

function post(contact: string, xff: string): NextRequest {
  return new NextRequest("https://marktmorgen.com/api/privacy/do-not-contact", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", origin: "https://marktmorgen.com", host: "marktmorgen.com", "x-forwarded-for": xff },
    body: new URLSearchParams({ contact, name: "", confirm: "yes" }),
  });
}
const statusOf = (response: Response) => new URL(response.headers.get("location")!).searchParams.get("status");

/**
 * The list filled to `entries` entries, written straight into the hash, with
 * the count the first version kept beside it and the public form's count of
 * requests at its ceiling (since the second pre-review the public form is
 * measured by that count, and the operator's room is what it leaves).
 */
function filled(entries: number): void {
  redis.clear();
  for (let i = 0; i < entries; i += 1) redis.run(["HSET", DO_NOT_CONTACT_KEY, `email:filler${i}@example.com`, ""]);
  redis.run(["SET", OLD_COUNT_KEY, String(entries)]);
  redis.run(["SET", DO_NOT_CONTACT_PUBLIC_KEY, String(RESEARCH_DO_NOT_CONTACT_PUBLIC_MAX)]);
}

test("with the list full, the public form answers the same whether or not the contact is on it", async () => {
  filled(RESEARCH_DO_NOT_CONTACT_MAX);
  const listed = statusOf(await POST(post("filler7@example.com", "203.0.113.10")));
  const unlisted = statusOf(await POST(post("stranger@example.com", "203.0.113.11")));
  assert.equal(listed, unlisted, `membership leaks: listed=${listed} unlisted=${unlisted}`);
  assert.equal(redis.run(["HLEN", DO_NOT_CONTACT_KEY]), RESEARCH_DO_NOT_CONTACT_MAX, "nothing written past the ceiling");
});

test("a write that fails leaves no place lost: the next person still gets on the list", async () => {
  filled(RESEARCH_DO_NOT_CONTACT_MAX - 1_500);
  const original = redis.pipeline;
  let failed = false;
  redis.pipeline = (async (commands) => {
    const name = String(commands[0]?.[0]).toUpperCase();
    if (!failed && (name === "HSETNX" || name === "EVAL")) {
      failed = true;
      throw new Error("connection reset");
    }
    return original.call(redis, commands);
  }) as typeof redis.pipeline;
  try {
    await addToDoNotContact({ contact: "lost@example.com", name: "" }).catch(() => "failed");
  } finally {
    redis.pipeline = original;
  }
  assert.ok(failed, "the write was made to fail");
  // Every place but one taken by others, through the count or the hash, whichever the code reads.
  redis.run(["INCRBY", OLD_COUNT_KEY, "1499"]);
  for (let i = 0; i < 1_499; i += 1) redis.run(["HSET", DO_NOT_CONTACT_KEY, `email:later${i}@example.com`, ""]);
  assert.equal(redis.run(["HLEN", DO_NOT_CONTACT_KEY]), RESEARCH_DO_NOT_CONTACT_MAX - 1);
  assert.equal(await addToDoNotContact({ contact: "next@example.com", name: "" }), "added", "the last place was lost to the failed write");
});

test("one IPv6 network is one connection, so it cannot fill the list from many of its addresses", async () => {
  redis.clear();
  let added = 0;
  for (let host = 1; host <= 4; host += 1) {
    for (let i = 0; i <= RESEARCH_STOP_PER_HOUR; i += 1) {
      if (statusOf(await POST(post(`junk${host}-${i}@example.com`, `2001:db8:1:2::${host}`))) === "done") added += 1;
    }
  }
  assert.ok(added <= RESEARCH_STOP_PER_HOUR, `one /64 added ${added} entries in an hour`);
  assert.equal(redis.run(["HLEN", DO_NOT_CONTACT_KEY]), added);
});

test("the contact detail kept is never more bytes than the registry says", () => {
  const registry = readFileSync(join(root, "tests/store-data-registry.ts"), "utf8");
  const said = /a contact detail of at most (\d+) bytes/.exec(registry);
  assert.ok(said, "the registry line names the bytes of a contact detail");
  const most = Number(said[1]);
  for (const raw of ["instagram.com/" + "é".repeat(286), "example.com/" + "%e2%82%ac".repeat(30), `${"a".repeat(64)}@${"b".repeat(60)}.com`]) {
    const kept = normalizeResearchContact(raw);
    if (kept === null) continue; // refused is fine
    assert.ok(Buffer.byteLength(kept, "utf8") <= most, `${raw.slice(0, 30)}… kept as ${Buffer.byteLength(kept, "utf8")} bytes, over ${most}`);
  }
  // The cost note uses the same figure.
  const cost = readFileSync(join(root, "tests/plan-cost-registry.ts"), "utf8");
  assert.match(cost, new RegExp(`contact detail of at most ${most} bytes`));
});

test("the common ways of writing one email address are one entry, and broken ones are refused", () => {
  const ana = normalizeResearchContact("ana@example.com");
  assert.equal(ana, "email:ana@example.com");
  for (const form of [
    "<ana@example.com>", "Ana@Example.com.", "ana@example.com,", "ana@example.com;", "\"ana@example.com\"", "'ana@example.com'",
    "“ana@example.com”", "mailto:ana@example.com", "MAILTO:Ana@Example.com?subject=Stop", " <mailto:ana@example.com>. ",
  ]) {
    assert.equal(normalizeResearchContact(form), ana, form);
  }
  for (const bad of ["ana@example..com", "ana..b@example.com", ".ana@example.com", "ana.@example.com", "ana@-example.com", "ana@example", "ana@@example.com", "ana@exa mple.com", "ana@example.c"]) {
    assert.equal(normalizeResearchContact(bad), null, bad);
  }
  // A domain written with accents is kept as the address mail goes to (punycode).
  assert.equal(normalizeResearchContact("ana@exämple.com"), "email:ana@xn--exmple-cua.com");
});

test("a profile link is one entry however it is written", () => {
  const ig = normalizeResearchContact("instagram.com/ana");
  assert.equal(ig, "link:instagram.com/ana");
  for (const form of ["m.instagram.com/ana", "https://m.instagram.com/ana/", "www.instagram.com/ana", "instagram.com./ana", "<https://instagram.com/ana>", "instagram.com/ana."]) {
    assert.equal(normalizeResearchContact(form), ig, form);
  }
});

test("a name cut to its length never splits a character", async () => {
  redis.clear();
  const name = "a".repeat(79) + "\u{1F600}" + "b";
  assert.equal(await addToDoNotContact({ contact: "emoji@example.com", name }), "added");
  const kept = String(redis.run(["HGET", DO_NOT_CONTACT_KEY, "email:emoji@example.com"]));
  assert.equal(kept.isWellFormed(), true, "a lone surrogate was kept");
  assert.equal(kept, "a".repeat(79) + "\u{1F600}");
});

test("the privacy policy and the page promise only what the code does", () => {
  const flat = (file: string) => (existsSync(join(root, file)) ? readFileSync(join(root, file), "utf8") : "").replace(/\s+/g, " ");
  const policy = flat("app/privacy/page.tsx");
  assert.doesNotMatch(policy, /Before we send any research message, we check/, "nothing sends research messages, and nothing checks them");
  assert.match(policy, /nothing on our site sends a research message without first checking/i);
  const page = flat("app/privacy/do-not-contact/page.tsx") + flat("components/do-not-contact-form.tsx");
  assert.doesNotMatch(page, /We check that list before any research message/);
});

// The guard on research senders by keyword that stood here became structural in
// tests/research-do-not-contact-sending.test.ts (every file that sends email is a known
// non-research sender, or lib/research-outreach.ts, which asks the list first).
