import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { NextRequest } from "next/server";
import { POST as checkPost } from "@/app/api/operator/do-not-contact/check/route";
import { DoNotContactForm } from "@/components/do-not-contact-form";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { addToDoNotContact } from "@/lib/research-do-not-contact";
import { sendResearchMessage } from "@/lib/research-outreach";
import { find, mount } from "./client-hooks";
import { NOT_RESEARCH_SENDERS } from "./email-senders";
import { store as redis } from "./redis-stub";

// "We will not contact you again" needs a way to keep it: research messages
// go out only through sendResearchMessage, which asks the list first, and the
// operator, writing by hand, can look a contact up on the same page.

const root = process.cwd();
const OPERATOR = "operator@example.test";

test("a research message is sent only to a contact the list says is clear", async () => {
  redis.clear();
  await addToDoNotContact({ contact: "listed@example.com", name: "" });
  const sent: { to: string; meter: unknown }[] = [];
  const send = async (m: { to: string; meter: unknown }) => {
    sent.push(m);
    return true;
  };
  const message = { from: "Marktmorgen <hello@marktmorgen.com>", subject: "A question", text: "Hello" };
  assert.equal(await sendResearchMessage({ ...message, to: "listed@example.com" }, send), "on-the-list");
  assert.equal(await sendResearchMessage({ ...message, to: "Listed+x@Example.com" }, send), "on-the-list");
  assert.equal(await sendResearchMessage({ ...message, to: "not a contact" }, send), "not-sent");
  const original = redis.pipeline;
  redis.pipeline = (async () => []) as typeof redis.pipeline;
  try {
    assert.equal(await sendResearchMessage({ ...message, to: "clear@example.com" }, send), "not-sent", "a list it cannot read sends nothing");
  } finally {
    redis.pipeline = original;
  }
  assert.equal(sent.length, 0);
  assert.equal(await sendResearchMessage({ ...message, to: "clear@example.com" }, send), "sent");
  assert.deepEqual(sent.map((m) => [m.to, m.meter]), [["clear@example.com", { by: "company" }]]);
});

/** Every file that imports a function that sends email, read from its imports, not from its words. */
function senderFiles(): string[] {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(join(root, dir))) {
      const path = `${dir}/${name}`;
      if (statSync(join(root, path)).isDirectory()) walk(path);
      else if (/\.(ts|tsx|mjs|js)$/.test(name)) files.push(path);
    }
  };
  for (const dir of ["app", "lib", "components", "scripts"]) walk(dir);
  const SENDING: Record<string, string[]> = { "@/lib/email": ["sendEmail", "sendBatch", "sendListBatch", "queuedShipmentMailSender"], "@/lib/mail": ["sendTo"] };
  const out = new Set<string>();
  for (const file of files) {
    const text = readFileSync(join(root, file), "utf8");
    for (const m of text.matchAll(/import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+["']([^"']+)["']/g)) {
      const from = m[2];
      const names = m[1].split(",").map((s) => s.trim().replace(/^type\s+/, "").split(/\s+as\s+/)[0]).filter(Boolean);
      if (Object.hasOwn(SENDING, from) ? names.some((n) => SENDING[from].includes(n)) : /(^|\/)(email|mail)$/.test(from) && from.startsWith(".")) out.add(file);
    }
    if (/import\s*\*\s*as\s+\w+\s+from\s+["']@\/lib\/(email|mail)["']|import\(\s*["']@\/lib\/(email|mail)["']\s*\)|require\(\s*["']@\/lib\/(email|mail)["']\s*\)/.test(text)) out.add(file);
  }
  return [...out].sort();
}

test("no path but sendResearchMessage can send a research message: every other sender is a known one that is not research", () => {
  const senders = senderFiles();
  assert.ok(senders.includes("lib/research-outreach.ts"));
  const unknown = senders.filter((f) => f !== "lib/research-outreach.ts" && !NOT_RESEARCH_SENDERS.includes(f));
  assert.deepEqual(unknown, [], "a new file that sends email: research goes through sendResearchMessage (lib/research-outreach.ts); anything else is added to tests/email-senders.ts");
  const gone = NOT_RESEARCH_SENDERS.filter((f) => !senders.includes(f));
  assert.deepEqual(gone, [], "remove from tests/email-senders.ts what no longer sends");
  // Nothing reaches a mail provider but lib/email.ts.
  const direct: string[] = [];
  for (const dir of ["app", "lib", "components", "scripts"]) {
    const walk = (d: string) => {
      for (const name of readdirSync(join(root, d))) {
        const path = `${d}/${name}`;
        if (statSync(join(root, path)).isDirectory()) walk(path);
        else if (/\.(ts|tsx|mjs|js)$/.test(name) && path !== "lib/email.ts" && /api\.resend\.com|SendEmailCommand|sesv2|\/v2\/email\/outbound-emails/.test(readFileSync(join(root, path), "utf8"))) direct.push(path);
      }
    };
    walk(dir);
  }
  assert.deepEqual(direct, []);
});

const req = (fields: Record<string, string>, headers: Record<string, string>) =>
  new NextRequest("https://marktmorgen.com/api/operator/do-not-contact/check", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", origin: "https://marktmorgen.com", host: "marktmorgen.com", ...headers },
    body: new URLSearchParams(fields),
  });

test("the operator can look a contact up before writing by hand; nobody else can", async () => {
  redis.clear();
  await addToDoNotContact({ contact: "listed@example.com", name: "" });
  const before = process.env.DEMO_STUDIO_ADMIN;
  process.env.DEMO_STUDIO_ADMIN = OPERATOR;
  try {
    const operator = { cookie: `${SESSION_COOKIE}=${await openSession(OPERATOR)}` };
    const ask = async (contact: string) => (await (await checkPost(req({ contact }, { ...operator, accept: "application/json" }))).json()) as { state: string };
    assert.deepEqual(await ask("Listed+x@example.com"), { state: "listed" });
    assert.deepEqual(await ask("clear@example.com"), { state: "clear" });
    assert.deepEqual(await ask("nobody"), { state: "contact" });
    const original = redis.pipeline;
    redis.pipeline = (async (c) => (c.some((one) => one[0] === "HEXISTS") ? [] : original.call(redis, c))) as typeof redis.pipeline;
    try {
      assert.deepEqual(await ask("clear@example.com"), { state: "unknown" });
    } finally {
      redis.pipeline = original;
    }
    // Without JavaScript: back to the page, the answer in the URL, the contact never.
    const plain = await checkPost(req({ contact: "listed@example.com" }, operator));
    assert.equal(plain.status, 303);
    const to = new URL(plain.headers.get("location")!);
    assert.equal(to.searchParams.get("status"), "check-listed");
    assert.doesNotMatch(to.toString(), /listed@example/);
    const stranger = { cookie: `${SESSION_COOKIE}=${await openSession("stranger@example.test")}` };
    assert.equal((await checkPost(req({ contact: "listed@example.com" }, stranger))).status, 404);
    assert.equal((await checkPost(req({ contact: "listed@example.com" }, {}))).status, 404);
  } finally {
    if (before === undefined) delete process.env.DEMO_STUDIO_ADMIN;
    else process.env.DEMO_STUDIO_ADMIN = before;
  }
});

type El = { type?: unknown; props?: Record<string, unknown> };

test("the operator's page has the look-up, and nobody else's does", async () => {
  const operator = await mount(DoNotContactForm, { status: "", operator: true });
  assert.equal(find(operator.tree(), (n: El) => n.type === "form" && n.props?.action === "/api/operator/do-not-contact/check").length, 1);
  const visitor = await mount(DoNotContactForm, { status: "", operator: false });
  assert.equal(find(visitor.tree(), (n: El) => n.type === "form" && n.props?.action === "/api/operator/do-not-contact/check").length, 0);
});
