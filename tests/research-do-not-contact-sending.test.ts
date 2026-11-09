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

/** Every source file the site runs or ships, with its text. */
function sources(): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (dir: string) => {
    for (const name of readdirSync(join(root, dir))) {
      const path = `${dir}/${name}`;
      if (statSync(join(root, path)).isDirectory()) walk(path);
      else if (/\.(ts|tsx|mjs|js)$/.test(name)) out.set(path, readFileSync(join(root, path), "utf8"));
    }
  };
  for (const dir of ["app", "lib", "components", "scripts"]) walk(dir);
  return out;
}

/** The modules a file imports from, read from its import statements (named, namespace, dynamic, require). */
function importsOf(text: string): { from: string; names: string[] | "*" }[] {
  const out: { from: string; names: string[] | "*" }[] = [];
  for (const m of text.matchAll(/import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+["']([^"']+)["']/g)) {
    out.push({ from: m[2], names: m[1].split(",").map((part) => part.trim().replace(/^type\s+/, "").split(/\s+as\s+/)[0]).filter(Boolean) });
  }
  for (const m of text.matchAll(/import\s*\*\s*as\s+\w+\s+from\s+["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)|require\(\s*["']([^"']+)["']\s*\)|export\s*\*\s*from\s+["']([^"']+)["']/g)) {
    out.push({ from: m[1] ?? m[2] ?? m[3] ?? m[4], names: "*" });
  }
  for (const m of text.matchAll(/export\s*\{([^}]*)\}\s*from\s+["']([^"']+)["']/g)) {
    out.push({ from: m[2], names: m[1].split(",").map((part) => part.trim().split(/\s+as\s+/)[0]).filter(Boolean) });
  }
  return out;
}

/** Functions that send email, by the module that holds them. */
const SENDING: Record<string, string[]> = {
  email: ["sendEmail", "sendBatch", "sendListBatch", "queuedShipmentMailSender"],
  mail: ["sendTo"],
  ses: ["sesSend", "sesBatch"],
};
const moduleOf = (from: string) => /(?:^@\/lib\/|^\.{1,2}\/(?:.*\/)?)([\w-]+)$/.exec(from)?.[1] ?? "";
const sends = (text: string) =>
  importsOf(text).some(({ from, names }) => Object.hasOwn(SENDING, moduleOf(from)) && (names === "*" || names.some((n) => SENDING[moduleOf(from)].includes(n))));
const RESEARCH_MODULES = new Set(["research-do-not-contact", "research-contact"]);
const touchesResearch = (text: string) => importsOf(text).some(({ from }) => RESEARCH_MODULES.has(moduleOf(from)));

/** Who may import the list's modules: the list itself, the one way to send research, and the do-not-contact page, form and routes. */
const LIST_IMPORTERS = [
  "lib/research-do-not-contact.ts",
  "lib/research-outreach.ts",
  "app/api/privacy/do-not-contact/route.ts",
  "app/api/operator/do-not-contact/route.ts",
  "app/api/operator/do-not-contact/check/route.ts",
  "app/privacy/do-not-contact/page.tsx",
  "components/do-not-contact-form.tsx",
];

test("no path but sendResearchMessage can send a research message, read from the code's imports and calls", () => {
  const code = sources();
  // 1. Only the list, the sending wrapper and the do-not-contact page, form and routes import the list's modules.
  const importers = [...code].filter(([file, text]) => file !== "lib/research-contact.ts" && touchesResearch(text)).map(([file]) => file);
  assert.deepEqual(importers.filter((file) => !LIST_IMPORTERS.includes(file)), [], "a research message goes out through sendResearchMessage (lib/research-outreach.ts), never with the list read elsewhere");
  // 2. Only sendResearchMessage asks the list to decide a sending; the operator's look-up asks it to show the answer, and sends nothing.
  const askers = [...code].filter(([file, text]) => file !== "lib/research-do-not-contact.ts" && /\b(mayContactForResearch|doNotContactState)\(/.test(text)).map(([file]) => file).sort();
  assert.deepEqual(askers, ["app/api/operator/do-not-contact/check/route.ts", "lib/research-outreach.ts"]);
  assert.equal(sends(code.get("app/api/operator/do-not-contact/check/route.ts")!), false, "the look-up sends nothing");
  // 3. No file but the wrapper imports both a function that sends and anything of the list's modules.
  const both = [...code].filter(([, text]) => sends(text) && touchesResearch(text)).map(([file]) => file);
  assert.deepEqual(both, ["lib/research-outreach.ts"]);
  // Nothing reaches a mail provider but the two transports, lib/email.ts (Resend) and lib/ses.ts (Amazon).
  const direct = [...code].filter(([file, text]) => file !== "lib/email.ts" && file !== "lib/ses.ts" && /api\.resend\.com|SendEmailCommand|sesv2|\/v2\/email\/outbound-emails/.test(text)).map(([file]) => file);
  assert.deepEqual(direct, []);
});

test("the guard reads what it must: a sender that imports the list fails it, one that does not passes", () => {
  assert.equal(sends('import { sendEmail } from "@/lib/email";'), true);
  assert.equal(sends('import { sesBatch as batch } from "./ses";'), true);
  assert.equal(sends('import * as mail from "@/lib/mail";'), true);
  assert.equal(sends('import { isSenderConfigured } from "@/lib/email";'), false);
  assert.equal(touchesResearch('import { normalizeResearchContact } from "@/lib/research-contact";'), true);
  assert.equal(touchesResearch('const m = await import("@/lib/research-do-not-contact");'), true);
  assert.equal(touchesResearch('import { sendResearchMessage } from "@/lib/research-outreach";'), false, "using the wrapper is the way");
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
