import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { isValidElement, type ReactNode } from "react";
import { NextRequest } from "next/server";
import { POST } from "@/app/api/privacy/do-not-contact/route";
import DoNotContactPage from "@/app/privacy/do-not-contact/page";
import { DoNotContactForm } from "@/components/do-not-contact-form";
import { DO_NOT_CONTACT_TRAP } from "@/lib/research-contact";
import {
  DO_NOT_CONTACT_KEY,
  RESEARCH_DO_NOT_CONTACT_MAX,
  RESEARCH_STOP_PER_HOUR,
  addToDoNotContact,
  mayContactForResearch,
  normalizeResearchContact,
} from "@/lib/research-do-not-contact";
import { PERSON_DATA } from "@/lib/person-data";
import { UPSTASH_MICRO_USD_PER_GB_MONTH } from "@/lib/spend-cost-table";
import { mount } from "./client-hooks";
import { answering } from "./security/next-headers";
import { store as redis } from "./redis-stub";

// The privacy policy promises that a person who asks Marktmorgen to stop its
// research outreach is kept on a do-not-contact list with only their name and
// contact detail (owner's decision 13, 9 November 2026). Before this list
// existed nothing kept the request, so no research contact could honor it.

const root = process.cwd();
const page = readFileSync(join(root, "app/privacy/page.tsx"), "utf8");
const flat = page.replace(/\s+/g, " ");

function paragraph(start: string): string {
  const at = flat.indexOf(start);
  assert.ok(at > 0, `"${start}" is in the privacy policy`);
  const end = flat.indexOf("</p>", at);
  assert.ok(end > at);
  return flat.slice(at, end);
}

let ip = 0;
function form(fields: Record<string, string>, headers: Record<string, string> = {}): NextRequest {
  ip += 1;
  return new NextRequest("https://marktmorgen.com/api/privacy/do-not-contact", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      origin: "https://marktmorgen.com",
      host: "marktmorgen.com",
      "x-forwarded-for": `203.0.113.${ip}`,
      ...headers,
    },
    // The person confirms the entry stays on the list (WCAG 3.3.6); tests/research-do-not-contact-operator.test.ts holds the refusal without it.
    body: new URLSearchParams({ confirm: "yes", ...fields }),
  });
}

function statusOf(response: Response): string | null {
  assert.equal(response.status, 303);
  const to = new URL(response.headers.get("location")!);
  assert.equal(to.pathname, "/privacy/do-not-contact");
  return to.searchParams.get("status");
}

test("a contact detail is kept in one normalized form, and anything else is refused", () => {
  assert.equal(normalizeResearchContact("  Ana.Lima@Example.COM "), "email:ana.lima@example.com");
  assert.equal(normalizeResearchContact("https://www.Instagram.com/AnaMakes/?hl=en#top"), "link:instagram.com/anamakes");
  assert.equal(normalizeResearchContact("instagram.com/anamakes/"), "link:instagram.com/anamakes");
  assert.equal(normalizeResearchContact("http://anamakes.com"), "link:anamakes.com");
  for (const bad of ["", "   ", "ana", "@anamakes", "not an address", "ana@", "javascript:alert(1)", "x".repeat(400)]) {
    assert.equal(normalizeResearchContact(bad), null, bad);
  }
});

test("asking to be left alone keeps only the contact detail and the name given, and stops any research contact", async () => {
  redis.clear();
  assert.equal(await mayContactForResearch("ana.lima@example.com"), true, "not on the list yet");
  assert.equal(await addToDoNotContact({ contact: "Ana.Lima@Example.com", name: "  Ana   Lima " }), "added");
  assert.equal(await mayContactForResearch("ANA.LIMA@example.com"), false, "the same address, written another way, is not contacted");
  assert.equal(await mayContactForResearch("other@example.com"), true);
  assert.deepEqual(redis.run(["HGETALL", DO_NOT_CONTACT_KEY]), ["email:ana.lima@example.com", "Ana Lima"], "only the contact and the name");
  assert.equal(await addToDoNotContact({ contact: "ana.lima@example.com", name: "" }), "listed", "asking twice keeps one entry");
  assert.equal(redis.run(["HLEN", DO_NOT_CONTACT_KEY]), 1);
  assert.equal(redis.run(["HLEN", DO_NOT_CONTACT_KEY]), 1, "a second ask takes no place on the list");
  assert.equal(await addToDoNotContact({ contact: "instagram.com/anamakes", name: "" }), "added");
  assert.deepEqual(redis.run(["HGET", DO_NOT_CONTACT_KEY, "link:instagram.com/anamakes"]), "", "no name given, none kept");
  assert.equal(await mayContactForResearch("https://www.instagram.com/AnaMakes"), false);
});

test("a contact the check cannot read, or a list it cannot read, is never contacted", async () => {
  redis.clear();
  assert.equal(await mayContactForResearch("not a contact"), false);
  const original = redis.pipeline;
  for (const reply of [[], [null], ["1"], [2], [-1], [0, 0]]) {
    redis.pipeline = (async () => reply) as typeof redis.pipeline;
    try {
      assert.equal(await mayContactForResearch("ana@example.com"), false, JSON.stringify(reply));
    } finally {
      redis.pipeline = original;
    }
  }
  redis.pipeline = (async () => {
    throw new Error("connection reset");
  }) as typeof redis.pipeline;
  try {
    assert.equal(await mayContactForResearch("ana@example.com"), false);
  } finally {
    redis.pipeline = original;
  }
});

test("the list has a fixed ceiling, so what it costs the company is bounded", async () => {
  redis.clear();
  for (let i = 0; i < RESEARCH_DO_NOT_CONTACT_MAX; i += 1) redis.run(["HSET", DO_NOT_CONTACT_KEY, `email:fill${i}@example.com`, ""]);
  assert.equal(await addToDoNotContact({ contact: "full@example.com", name: "Full" }), "full");
  assert.equal(redis.run(["HLEN", DO_NOT_CONTACT_KEY]), RESEARCH_DO_NOT_CONTACT_MAX, "nothing written past the ceiling");
  assert.ok(RESEARCH_DO_NOT_CONTACT_MAX > 0 && RESEARCH_DO_NOT_CONTACT_MAX <= 20_000);
  // About 700 bytes an entry with what Redis keeps beside it (tests/store-data-registry.ts, nl:research:dnc).
  const monthlyUsd = (RESEARCH_DO_NOT_CONTACT_MAX * 700 / 1e9) * (UPSTASH_MICRO_USD_PER_GB_MONTH / 1e6);
  assert.ok(monthlyUsd > 0 && monthlyUsd < 0.002, `the full list kept a month: $${monthlyUsd}`);
});

test("the public form adds a person without an account, and refuses what it should", async () => {
  redis.clear();
  assert.equal(statusOf(await POST(form({ contact: "Bo@example.com", name: "Bo" }))), "done");
  assert.equal(await mayContactForResearch("bo@example.com"), false);
  assert.equal(statusOf(await POST(form({ contact: "bo@example.com", name: "" }))), "done", "asking again says the same");
  assert.equal(statusOf(await POST(form({ contact: "nobody", name: "" }))), "contact");
  // A field no person sees: told only that nothing was saved, and nothing kept.
  assert.equal(statusOf(await POST(form({ contact: "bot@example.com", name: "", [DO_NOT_CONTACT_TRAP]: "spam" }))), "error");
  assert.equal(await mayContactForResearch("bot@example.com"), true);
  const other = (await POST(form({ contact: "x@example.com" }, { origin: "https://evil.example", "sec-fetch-site": "cross-site" })));
  assert.equal(other.status, 403);
  assert.equal(await mayContactForResearch("x@example.com"), true);
  // One connection, past its hour.
  const same = { "x-forwarded-for": "198.51.100.7" };
  for (let i = 0; i < RESEARCH_STOP_PER_HOUR; i += 1) assert.equal(statusOf(await POST(form({ contact: `p${i}@example.com` }, same))), "done");
  assert.equal(statusOf(await POST(form({ contact: "late@example.com" }, same))), "limited");
  assert.equal(await mayContactForResearch("late@example.com"), true);
  // A list that cannot be written says so, never "done".
  const original = redis.pipeline;
  redis.pipeline = (async (commands) =>
    commands.some((c) => c.some((part) => String(part).startsWith("nl:research:"))) ? [] : original.call(redis, commands)) as typeof redis.pipeline;
  try {
    assert.equal(statusOf(await POST(form({ contact: "err@example.com" }))), "error");
  } finally {
    redis.pipeline = original;
  }
});

test("the privacy policy names the page that does it and says exactly what is kept", () => {
  const outreach = paragraph('<strong className="text-black">Research outreach.</strong>');
  assert.match(outreach, /href="\/privacy\/do-not-contact"/, "the objection names the page that adds you to the list");
  assert.match(outreach, /mailto:support@marktmorgen\.com/, "and the support address still works");
  assert.match(outreach, /nothing on our site sends a research message without first checking it/, "no research contact without checking the list");
  const kept = paragraph("Research outreach records");
  assert.match(kept, /only the contact detail you gave us and, if you gave it, your name/);
  assert.match(kept, /even if you ask us to delete your data/);
  assert.doesNotMatch(kept, /we keep only your name and contact detail on a do-not-contact list/, "the old wording, which no code kept");
});

type Props = { id?: string; role?: string; children?: ReactNode; "aria-invalid"?: boolean; "aria-describedby"?: string; action?: string; htmlFor?: string };
function find(node: ReactNode, match: (p: Props, type: unknown) => boolean, out: Props[] = []): Props[] {
  if (Array.isArray(node)) {
    for (const child of node) find(child, match, out);
    return out;
  }
  if (!isValidElement<Props>(node)) return out;
  if (match(node.props, node.type)) out.push(node.props);
  find(node.props.children, match, out);
  return out;
}

test("the page labels each field, says a wrong entry as an alert tied to its field, and posts to the route", async () => {
  answering(new Request("https://marktmorgen.com/privacy/do-not-contact"));
  let page: ReactNode;
  try {
    page = await DoNotContactPage({ searchParams: Promise.resolve({ status: "contact" }) });
  } finally {
    answering(null);
  }
  const placed = find(page, (_p, t) => t === DoNotContactForm) as unknown as { status: string; operator: boolean }[];
  assert.deepEqual(placed.map((p) => [p.status, p.operator]), [["contact", false]], "the page hands the form the server's answer");
  assert.equal(find(page, (p, t) => t === "nav").length, 1, "a breadcrumb says where the page is");
  const show = async (status: string) => (await mount(DoNotContactForm, { status, operator: false })).tree() as ReactNode;
  const plain = await show("");
  assert.equal(find(plain, (p, t) => t === "form" && p.action === "/api/privacy/do-not-contact").length, 1);
  assert.equal(find(plain, (p, t) => t === "label" && p.htmlFor === "dnc-contact").length, 1);
  assert.equal(find(plain, (p, t) => t === "label" && p.htmlFor === "dnc-name").length, 1);
  assert.equal(find(plain, (p, t) => t === "label" && p.htmlFor === "dnc-confirm").length, 1);
  assert.equal(find(plain, (p) => p.id === "dnc-contact")[0]["aria-invalid"], undefined);
  const wrong = await show("contact");
  assert.equal(find(wrong, (p) => p.role === "alert" && p.id === "dnc-status").length, 1);
  const field = find(wrong, (p) => p.id === "dnc-contact")[0];
  assert.equal(field["aria-invalid"], true);
  assert.equal(field["aria-describedby"], "dnc-contact-hint dnc-status");
  assert.equal(find(await show("done"), (p) => p.role === "status").length, 1);
  for (const made of ["made-up", "constructor", "toString"]) assert.equal(find(await show(made), (p) => p.role === "alert" || p.role === "status").length, 0, made);
});

test("the list is in the registry of what is kept about people, as Marktmorgen's own", () => {
  const line = PERSON_DATA.find((d) => d.file === "lib/research-do-not-contact.ts");
  assert.ok(line, "lib/person-data.ts has a line for it");
  assert.equal(line.how, "account");
  assert.match(line.what, /do-not-contact/);
  assert.match(line.what, /kept when they ask to be deleted/);
});
