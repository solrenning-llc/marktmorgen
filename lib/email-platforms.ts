/**
 * The four email platforms a creator can connect, and exactly how each one
 * is spoken to: Mailchimp (Marketing API 3.0), Kit (formerly ConvertKit, API
 * v4), beehiiv (API v2) and MailerLite (the current API at
 * connect.mailerlite.com).
 *
 * Each is reached with the creator's own API key (kept sealed by
 * lib/email-sync.ts) and only at its own API host: HOSTS is the whole list,
 * checked before every request, and every request goes through
 * lib/safe-fetch.ts as well, which refuses private networks, and is told to
 * follow no redirect, so an answer cannot send a request with the key on it
 * anywhere else. Nothing here is a dependency: the four APIs are plain JSON
 * over https.
 *
 * What each platform is asked to do with a person, and what it is never
 * asked to do:
 *
 *   Mailchimp   add them to the audience as "subscribed" (they agreed), with
 *               their first name when there is one; someone already in the
 *               audience is left exactly as they are — an unsubscribed
 *               person is never subscribed again — and only given the tags.
 *   Kit         create or update the subscriber, add them to the form (which
 *               starts whatever the creator attached to it), and tag them.
 *   beehiiv     add a subscription to the publication, never reactivating one
 *               that was ended, then tag it.
 *   MailerLite  add or update the subscriber in the group, without changing
 *               their status; "tags" become groups of that name, since
 *               MailerLite has groups and not tags.
 *
 * A tag named for the first time is created on Kit and on MailerLite, which
 * need its id; Mailchimp and beehiiv take the name itself.
 */
import { createHash } from "node:crypto";
import { SafeFetchError, safeFetch, type SafeFetchOptions } from "@/lib/safe-fetch";

export const EMAIL_PROVIDERS = ["mailchimp", "kit", "beehiiv", "mailerlite"] as const;
export type EmailProvider = (typeof EMAIL_PROVIDERS)[number];

export function isProvider(value: unknown): value is EmailProvider {
  return typeof value === "string" && (EMAIL_PROVIDERS as readonly string[]).includes(value);
}

export const PROVIDER_NAMES: Record<EmailProvider, string> = {
  mailchimp: "Mailchimp",
  kit: "Kit",
  beehiiv: "beehiiv",
  mailerlite: "MailerLite",
};

/** What the creator picks on each platform, in its own word. */
export const TARGET_WORDS: Record<EmailProvider, string> = {
  mailchimp: "audience",
  kit: "form",
  beehiiv: "publication",
  mailerlite: "group",
};

/** The only hosts a request of this file may go to. */
const HOSTS: Record<EmailProvider, RegExp> = {
  mailchimp: /^[a-z]{2,4}\d{1,3}\.api\.mailchimp\.com$/,
  kit: /^api\.kit\.com$/,
  beehiiv: /^api\.beehiiv\.com$/,
  mailerlite: /^connect\.mailerlite\.com$/,
};

/** The longest key accepted. MailerLite's are the long ones, at about a thousand characters. */
export const MAX_KEY_LENGTH = 2000;
/** How long one request may take. */
const CALL_TIMEOUT_MS = 8_000;
/** How many lists, forms, publications or groups are read for the picker. */
export const MAX_TARGETS = 100;

/** Why a request did not do what it was sent to do, and whether trying later could help. */
export class PlatformError extends Error {
  readonly status: number;
  /** "key": the key was refused. "target": the audience is gone. "contact": this person cannot be added. */
  readonly kind: "key" | "target" | "contact" | "limit" | "server" | "network";

  constructor(kind: PlatformError["kind"], status: number, message: string, private readonly mayRetry = true) {
    super(message);
    this.kind = kind;
    this.status = status;
  }

  /** A contact refusal or confirmed picker limitation cannot be fixed by an automatic retry. */
  get retry(): boolean {
    return this.kind !== "contact" && this.mayRetry;
  }
}

/** Says whether a pasted key has the shape the platform gives, or what is wrong with it. */
export function keyProblem(provider: EmailProvider, raw: string): string | null {
  const key = raw.trim();
  if (!key) return "Paste your API key.";
  if (key.length > MAX_KEY_LENGTH || /\s/.test(key)) return "That does not look like an API key.";
  if (provider === "mailchimp" && !/^[0-9a-f]{32}-[a-z]{2,4}\d{1,3}$/.test(key)) {
    return "A Mailchimp API key ends in the data center it lives in, like “-us21.” Copy the whole key.";
  }
  if (provider !== "mailchimp" && !/^[A-Za-z0-9._-]{16,}$/.test(key)) return "That does not look like an API key.";
  return null;
}

function base(provider: EmailProvider, key: string): string {
  switch (provider) {
    case "mailchimp":
      // The data centre is the part of the key after the dash.
      return `https://${key.split("-").pop()}.api.mailchimp.com/3.0`;
    case "kit":
      return "https://api.kit.com/v4";
    case "beehiiv":
      return "https://api.beehiiv.com/v2";
    case "mailerlite":
      return "https://connect.mailerlite.com/api";
  }
}

function authHeaders(provider: EmailProvider, key: string): Record<string, string> {
  if (provider === "mailchimp") return { Authorization: `Basic ${Buffer.from(`nimbus:${key}`).toString("base64")}` };
  if (provider === "kit") return { "X-Kit-Api-Key": key };
  return { Authorization: `Bearer ${key}` };
}

/** Test seams for the fetch; production passes nothing. */
export type PlatformHooks = Pick<SafeFetchOptions, "resolve" | "agent">;
let hooksForTests: PlatformHooks | undefined;
/** Lets a local check point requests at stand-ins. Never called by the app. */
export function setPlatformHooksForTests(hooks: PlatformHooks | undefined): void {
  hooksForTests = hooks;
}

type Answer = { status: number; json: Record<string, unknown> };

/** One request to a platform's API, with its key, at its own host and nowhere else. */
async function call(
  provider: EmailProvider,
  key: string,
  method: "GET" | "POST",
  path: string,
  body: unknown,
  deadline: number,
): Promise<Answer> {
  const url = `${base(provider, key)}${path}`;
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" || parsed.port || !HOSTS[provider].test(parsed.hostname)) {
    throw new PlatformError("key", 0, "That key names a server we do not send to.");
  }
  const left = deadline - Date.now();
  if (left <= 500) throw new PlatformError("network", 0, `${PROVIDER_NAMES[provider]} took too long to answer.`);
  let answer;
  try {
    answer = await safeFetch(url, {
      method,
      headers: {
        Accept: "application/json",
        "User-Agent": "Marktmorgen-EmailSync/1.0 (+https://marktmorgen.com)",
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        ...authHeaders(provider, key),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      maxBytes: 1_000_000,
      timeoutMs: Math.min(CALL_TIMEOUT_MS, left),
      maxRedirects: 0,
      ...(hooksForTests ?? {}),
    });
  } catch (error) {
    const words = error instanceof SafeFetchError && error.problem === "timeout" ? "took too long to answer" : "could not be reached";
    throw new PlatformError("network", 0, `${PROVIDER_NAMES[provider]} ${words}.`);
  }
  let json: Record<string, unknown> = {};
  try {
    const text = answer.body.toString("utf8");
    const value: unknown = text ? JSON.parse(text) : {};
    if (value && typeof value === "object" && !Array.isArray(value)) json = value as Record<string, unknown>;
  } catch {
    json = {};
  }
  return { status: answer.status, json };
}

/** What the platform said about a failed request, in a few words of its own. */
function detail(json: Record<string, unknown>): string {
  const pick = (value: unknown) => (typeof value === "string" ? value : "");
  const errors = json.errors;
  const first = Array.isArray(errors) ? errors[0] : errors && typeof errors === "object" ? Object.values(errors)[0] : undefined;
  const fromErrors = typeof first === "string" ? first : Array.isArray(first) ? pick(first[0]) : first && typeof first === "object" ? pick((first as Record<string, unknown>).message) : "";
  const text = pick(json.detail) || pick(json.message) || fromErrors || pick(json.title) || pick(json.error);
  return text.replace(/\s+/g, " ").trim().slice(0, 200);
}

/** Turns an answer that is not a success into the error it means. */
function failure(provider: EmailProvider, answer: Answer, what: "key" | "target" | "contact"): PlatformError {
  const name = PROVIDER_NAMES[provider];
  const said = detail(answer.json);
  const { status } = answer;
  if (status === 401 || status === 403) return new PlatformError("key", status, `${name} did not accept the API key${said ? `: ${said}` : "."}`);
  if (status === 404 && what !== "key") return new PlatformError("target", status, `${name} says the ${TARGET_WORDS[provider]} is not there anymore.`);
  if (status === 429) return new PlatformError("limit", status, `${name} asked us to slow down.`);
  if (status >= 500 || status === 0) return new PlatformError("server", status, `${name} had a problem (${status}).`);
  if (what === "contact") return new PlatformError("contact", status, `${name} refused this address${said ? `: ${said}` : "."}`);
  return new PlatformError("server", status, `${name} answered ${status}${said ? `: ${said}` : "."}`);
}

const ok = (answer: Answer) => answer.status >= 200 && answer.status < 300;

/**
 * Checks the key with the lightest request each platform has. Throws a
 * PlatformError saying what is wrong.
 */
export async function ping(provider: EmailProvider, key: string, deadline = Date.now() + 10_000): Promise<void> {
  const path = { mailchimp: "/ping", kit: "/account", beehiiv: "/publications?limit=1", mailerlite: "/groups?limit=1" }[provider];
  const answer = await call(provider, key, "GET", path, undefined, deadline);
  if (!ok(answer)) throw failure(provider, answer, "key");
}

export type Target = { id: string; name: string };

const TARGET_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** The audiences, forms, publications or groups the key can reach, for the creator to pick one. */
export async function listTargets(provider: EmailProvider, key: string, deadline = Date.now() + 10_000): Promise<Target[]> {
  const path = {
    mailchimp: `/lists?count=${MAX_TARGETS}&fields=lists.id,lists.name,total_items`,
    kit: `/forms?status=active&per_page=${MAX_TARGETS}`,
    beehiiv: `/publications?limit=${MAX_TARGETS}`,
    mailerlite: `/groups?limit=${MAX_TARGETS}&sort=name`,
  }[provider];
  const answer = await call(provider, key, "GET", path, undefined, deadline);
  if (!ok(answer)) throw failure(provider, answer, "key");
  const rows = answer.json[provider === "mailchimp" ? "lists" : provider === "kit" ? "forms" : "data"];
  const unconfirmed = () => new PlatformError("server", answer.status, `${PROVIDER_NAMES[provider]} returned an incomplete or unreadable destination list. Nothing was changed.`);
  // An unreadable page is not an empty list. Reconnecting uses this evidence
  // to retain the chosen destination, so never return a partial page either.
  if (!Array.isArray(rows)) throw unconfirmed();
  // The callers use absence to clear a saved destination or mark it missing.
  // A first page cannot prove absence. Stay inside the existing single request
  // and picker bound: refuse more pages or missing/contradictory metadata.
  // Sources: Kit forms/pagination; Mailchimp lists; beehiiv publications;
  // MailerLite groups (official API documentation, checked 2026-11-07).
  const data = answer.json;
  const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const pagination = record(data.pagination);
  const links = record(data.links);
  const meta = record(data.meta);
  const complete = provider === "mailchimp"
    ? Number.isSafeInteger(data.total_items) && data.total_items === rows.length
    : provider === "kit"
      ? pagination.has_previous_page === false && pagination.has_next_page === false
      : provider === "beehiiv"
        ? data.page === 1 && (data.total_pages === 1 || (rows.length === 0 && data.total_pages === 0)) && Number.isSafeInteger(data.total_results) && data.total_results === rows.length
        : links.prev === null && links.next === null && meta.current_page === 1 && meta.last_page === 1 && Number.isSafeInteger(meta.total) && meta.total === rows.length;
  // A full first page with consistent, explicit continuation describes an
  // account our picker cannot list completely; it is not a provider failure.
  const larger = rows.length === MAX_TARGETS && (provider === "mailchimp"
    ? Number.isSafeInteger(data.total_items) && (data.total_items as number) > MAX_TARGETS
    : provider === "kit"
      ? pagination.has_previous_page === false && pagination.has_next_page === true
      : provider === "beehiiv"
        ? data.page === 1 && Number.isSafeInteger(data.total_pages) && (data.total_pages as number) > 1 && Number.isSafeInteger(data.total_results) && (data.total_results as number) > MAX_TARGETS
        : links.prev === null && typeof links.next === "string" && links.next.length > 0 && meta.current_page === 1 && Number.isSafeInteger(meta.last_page) && (meta.last_page as number) > 1 && Number.isSafeInteger(meta.total) && (meta.total as number) > MAX_TARGETS);
  if ((!complete && !larger) || rows.length > MAX_TARGETS) throw unconfirmed();
  const targets: Target[] = [];
  for (const row of rows) {
    if (!row || typeof row !== "object" || Array.isArray(row)) throw unconfirmed();
    const value = row as Record<string, unknown>;
    const id = typeof value.id === "number" && Number.isSafeInteger(value.id) ? String(value.id) : typeof value.id === "string" ? value.id : "";
    if (!TARGET_ID.test(id)) throw unconfirmed();
    const name = typeof value.name === "string" ? value.name.replace(/\s+/g, " ").trim().slice(0, 100) : "";
    targets.push({ id, name: name || id });
  }
  if (larger) throw new PlatformError("server", answer.status, `Your ${PROVIDER_NAMES[provider]} account has more destinations than we can list on one page. Nothing was connected or changed. Use an account with fewer destinations.`, false);
  return targets;
}

export type Contact = {
  email: string;
  firstName: string | null;
  tags: string[];
  /** "free" or "purchase", for the platforms that keep where a subscriber came from. */
  source: "free" | "purchase";
  /** The store's own address, for beehiiv's "referring site". */
  storeUrl: string;
};

/**
 * Where tag ids learned from Kit and MailerLite are kept between sends, so a
 * tag is looked up or created once, not once per person.
 */
export type TagCache = { get: (name: string) => Promise<string | null>; set: (name: string, id: string) => Promise<void> };

/** Finds a tag (Kit) or a group (MailerLite) by name, creating it when there is none. */
async function tagId(provider: "kit" | "mailerlite", key: string, name: string, cache: TagCache, deadline: number): Promise<string> {
  const known = await cache.get(name);
  if (known) return known;
  const wanted = name.toLowerCase();
  const listPath = provider === "kit" ? "/tags?per_page=1000" : `/groups?limit=50&filter[name]=${encodeURIComponent(name)}`;
  const found = async (): Promise<string | null> => {
    const answer = await call(provider, key, "GET", listPath, undefined, deadline);
    if (!ok(answer)) throw failure(provider, answer, "key");
    const rows = answer.json[provider === "kit" ? "tags" : "data"];
    const row = Array.isArray(rows)
      ? (rows as Record<string, unknown>[]).find((r) => typeof r.name === "string" && r.name.trim().toLowerCase() === wanted)
      : undefined;
    return row && (typeof row.id === "number" || typeof row.id === "string") ? String(row.id) : null;
  };
  let id = await found();
  if (!id) {
    const created = await call(provider, key, "POST", provider === "kit" ? "/tags" : "/groups", { name }, deadline);
    const made = (created.json[provider === "kit" ? "tag" : "data"] ?? {}) as Record<string, unknown>;
    if (ok(created) && (typeof made.id === "number" || typeof made.id === "string")) id = String(made.id);
    // Made at the same moment by another send: it is there now.
    else if (created.status === 422 || created.status === 409) id = await found();
    else throw failure(provider, created, "key");
  }
  if (!id || !TARGET_ID.test(id)) throw new PlatformError("server", 0, `${PROVIDER_NAMES[provider]} did not give the ${provider === "kit" ? "tag" : "group"} “${name}” an id.`);
  await cache.set(name, id);
  return id;
}

/**
 * Adds one person who agreed to hear from the creator. Returns a few words on
 * what the platform did, for the studio's log; throws a PlatformError when it
 * did not.
 */
export async function addContact(
  provider: EmailProvider,
  key: string,
  target: string,
  contact: Contact,
  cache: TagCache,
  deadline = Date.now() + 20_000,
): Promise<string> {
  const email = contact.email.trim().toLowerCase();
  const target_ = encodeURIComponent(target);
  const tagged = contact.tags.length ? `, tagged ${contact.tags.map((t) => `“${t}”`).join(", ")}` : "";

  if (provider === "mailchimp") {
    const body = (withName: boolean) => ({
      email_address: email,
      status: "subscribed",
      ...(withName && contact.firstName ? { merge_fields: { FNAME: contact.firstName } } : {}),
      ...(contact.tags.length ? { tags: contact.tags } : {}),
    });
    let answer = await call(provider, key, "POST", `/lists/${target_}/members`, body(true), deadline);
    // An audience without the usual first-name field: sent again without it.
    if (answer.status === 400 && contact.firstName && /merge/i.test(detail(answer.json))) {
      answer = await call(provider, key, "POST", `/lists/${target_}/members`, body(false), deadline);
    }
    if (ok(answer)) return `Added as subscribed${tagged}.`;
    const title = typeof answer.json.title === "string" ? answer.json.title : "";
    if (answer.status === 400 && /member exists/i.test(title)) {
      // Already in the audience, whatever their status: left as they are.
      if (contact.tags.length) {
        const hash = createHash("md5").update(email).digest("hex");
        const tags = await call(provider, key, "POST", `/lists/${target_}/members/${hash}/tags`, { tags: contact.tags.map((name) => ({ name, status: "active" })) }, deadline);
        if (!ok(tags)) throw failure(provider, tags, "contact");
      }
      return `Already in the audience; left as they were${tagged}.`;
    }
    if (answer.status === 400 && /forgotten/i.test(title)) {
      throw new PlatformError("contact", 400, "Mailchimp does not let an address it was asked to delete be added again, except through a Mailchimp sign-up form.");
    }
    throw failure(provider, answer, "contact");
  }

  if (provider === "kit") {
    const made = await call(provider, key, "POST", "/subscribers", { email_address: email, ...(contact.firstName ? { first_name: contact.firstName } : {}) }, deadline);
    if (!ok(made)) throw failure(provider, made, "contact");
    const form = await call(provider, key, "POST", `/forms/${target_}/subscribers`, { email_address: email }, deadline);
    if (!ok(form)) throw failure(provider, form, "target");
    for (const name of contact.tags) {
      const id = await tagId("kit", key, name, cache, deadline);
      const tag = await call(provider, key, "POST", `/tags/${encodeURIComponent(id)}/subscribers`, { email_address: email }, deadline);
      if (!ok(tag)) throw failure(provider, tag, "contact");
    }
    return `Added to the form${tagged}.`;
  }

  if (provider === "beehiiv") {
    const made = await call(
      provider,
      key,
      "POST",
      `/publications/${target_}/subscriptions`,
      {
        email,
        reactivate_existing: false,
        send_welcome_email: false,
        utm_source: "marktmorgen",
        utm_medium: contact.source === "free" ? "free-product" : "purchase",
        referring_site: contact.storeUrl,
      },
      deadline,
    );
    if (!ok(made)) throw failure(provider, made, made.status === 404 ? "target" : "contact");
    const data = (made.json.data ?? {}) as Record<string, unknown>;
    const id = typeof data.id === "string" ? data.id : "";
    if (contact.tags.length && id) {
      const tags = await call(provider, key, "POST", `/publications/${target_}/subscriptions/${encodeURIComponent(id)}/tags`, { tags: contact.tags }, deadline);
      if (!ok(tags)) throw failure(provider, tags, "contact");
    }
    const status = typeof data.status === "string" ? data.status : "";
    return status && status !== "active" && status !== "validating" ? `Sent; beehiiv lists them as ${status}${tagged}.` : `Added to the publication${tagged}.`;
  }

  // MailerLite: the group, and a group for each tag.
  const groups = [target];
  for (const name of contact.tags) groups.push(await tagId("mailerlite", key, name, cache, deadline));
  const made = await call(
    provider,
    key,
    "POST",
    "/subscribers",
    { email, groups, ...(contact.firstName ? { fields: { name: contact.firstName } } : {}) },
    deadline,
  );
  // A group that was deleted is answered as an invalid field, not as missing.
  const goneGroup = made.status === 422 && /groups/i.test(JSON.stringify(made.json.errors ?? ""));
  if (!ok(made)) throw goneGroup ? new PlatformError("target", 422, "MailerLite says the group is not there anymore.") : failure(provider, made, made.status === 404 ? "target" : "contact");
  return `${made.status === 201 ? "Added" : "Updated"} in the group${contact.tags.length ? `, and in ${contact.tags.map((t) => `“${t}”`).join(", ")}` : ""}.`;
}
