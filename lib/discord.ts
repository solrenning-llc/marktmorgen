/**
 * The calls to Discord (lib/discord-rules.ts says what they are for).
 *
 * One Discord application, Marktmorgen's, with a bot. A creator adds the bot
 * to their own server through Discord's own page; a buyer lets the
 * application put them in that server, through Discord's own page too. What
 * comes back from those pages is a one-time code, swapped here for what it
 * stands for. The bot does three things and nothing else: put a person in
 * the server, give and take back roles, and, when the creator asked for it,
 * take a person out. It never reads a message.
 *
 *   DISCORD_CLIENT_SECRET   the application's secret (its id is public, written below)
 *   DISCORD_BOT_TOKEN                          its bot
 *
 * Off — every page that offers it says nothing about it — until all three
 * are set. Every call is answered within a few seconds or treated as failed.
 */
import { BOT_PERMISSIONS, type DiscordRole, SNOWFLAKE } from "@/lib/discord-rules";
import { SITE_URL } from "@/lib/site-url";

const LOCAL = /^http:\/\/127\.0\.0\.1:\d+$/.test(process.env.DISCORD_API_BASE ?? "") ? `${process.env.DISCORD_API_BASE}` : "";
/** Discord's API, or the stand-in the end-to-end run starts on this computer. */
const API = LOCAL ? `${LOCAL}/discord/api/v10` : "https://discord.com/api/v10";
const AUTHORIZE = LOCAL ? `${LOCAL}/discord/oauth2/authorize` : "https://discord.com/oauth2/authorize";
const TIMEOUT_MS = 8_000;

/**
 * The application's id is public: Discord shows it in every address of its
 * consent page. So it is written here, and only the two secrets live in the
 * deployment's settings. A different one there takes over.
 */
const MARKTMORGEN_APP = "1559060286475083856";
const clientId = () => (process.env.DISCORD_CLIENT_ID ?? "").trim() || MARKTMORGEN_APP;
const clientSecret = () => (process.env.DISCORD_CLIENT_SECRET ?? "").trim();
const botToken = () => (process.env.DISCORD_BOT_TOKEN ?? "").trim();

export function isDiscordConfigured(): boolean {
  return Boolean(SNOWFLAKE.test(clientId()) && clientSecret() && botToken());
}

type Answer = { status: number; data: unknown };

async function call(path: string, init: { method?: string; bearer?: string; json?: unknown; form?: URLSearchParams; reason?: string } = {}): Promise<Answer> {
  const headers: Record<string, string> = { "User-Agent": "DiscordBot (https://marktmorgen.com, 1.0)" };
  if (init.bearer) headers.Authorization = `Bearer ${init.bearer}`;
  else if (!init.form) headers.Authorization = `Bot ${botToken()}`;
  if (init.json !== undefined) headers["Content-Type"] = "application/json";
  if (init.form) headers["Content-Type"] = "application/x-www-form-urlencoded";
  // Shown in the server's audit log, so the creator can see why somebody was given a role.
  if (init.reason) headers["X-Audit-Log-Reason"] = encodeURIComponent(init.reason.slice(0, 200));
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const response = await fetch(`${API}${path}`, {
      method: init.method ?? "GET",
      headers,
      body: init.form ? init.form.toString() : init.json !== undefined ? JSON.stringify(init.json) : undefined,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const text = await response.text();
    let data: unknown = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = null;
    }
    // Too fast: Discord says how long to wait. Once, and only for a short wait.
    if (response.status === 429 && attempt === 0) {
      const wait = Number((data as { retry_after?: unknown } | null)?.retry_after) || 1;
      if (wait <= 5) {
        await new Promise((done) => setTimeout(done, Math.ceil(wait * 1000)));
        continue;
      }
    }
    return { status: response.status, data };
  }
  return { status: 429, data: null };
}

/**
 * Where Discord's page sends a person back: always this site's own address,
 * the one registered with the application, whichever address the store was
 * opened on; the stand-in of the end-to-end run sends back to the address
 * under test.
 */
export function redirectUri(origin: string): string {
  return `${LOCAL ? origin : SITE_URL}/api/discord/callback`;
}

/**
 * Discord's own page: for a creator, adding the bot to a server of theirs
 * with the permissions it needs; for a buyer, letting the application see
 * who they are and put them in a server.
 */
export function authorizeUrl(kind: "install" | "join", state: string, redirect: string): string {
  const query = new URLSearchParams({ client_id: clientId(), response_type: "code", redirect_uri: redirect, state, prompt: "consent" });
  if (kind === "install") {
    // "identify" beside "bot" makes it the full flow Discord's guide calls
    // advanced bot authorization: the code is required, and swapping it says
    // which server the bot was added to (the server named in the address
    // back is only a hint). The application has "Requires OAuth2 Code Grant" on.
    query.set("scope", "identify bot");
    query.set("permissions", BOT_PERMISSIONS);
  } else {
    query.set("scope", "identify guilds.join");
  }
  return `${AUTHORIZE}?${query}`;
}

/** Swaps the code Discord's page sent back for what it stands for: a way to act for the buyer, and for a creator, the server the bot was added to. */
export async function exchange(code: string, redirect: string): Promise<{ accessToken: string; serverId: string | null; serverName: string } | null> {
  const form = new URLSearchParams({ client_id: clientId(), client_secret: clientSecret(), grant_type: "authorization_code", code, redirect_uri: redirect });
  const answer = await call("/oauth2/token", { method: "POST", form }).catch(() => null);
  const data = (answer?.data ?? {}) as { access_token?: unknown; guild?: { id?: unknown; name?: unknown } };
  if (!answer || answer.status !== 200 || typeof data.access_token !== "string") return null;
  const serverId = typeof data.guild?.id === "string" && SNOWFLAKE.test(data.guild.id) ? data.guild.id : null;
  return { accessToken: data.access_token, serverId, serverName: typeof data.guild?.name === "string" ? data.guild.name : "" };
}

/** Who agreed on Discord's page. */
export async function whoIs(accessToken: string): Promise<{ id: string; name: string } | null> {
  const answer = await call("/users/@me", { bearer: accessToken }).catch(() => null);
  const data = (answer?.data ?? {}) as { id?: unknown; username?: unknown; global_name?: unknown };
  if (!answer || answer.status !== 200 || typeof data.id !== "string" || !SNOWFLAKE.test(data.id)) return null;
  const name = typeof data.global_name === "string" && data.global_name ? data.global_name : typeof data.username === "string" ? data.username : "";
  return { id: data.id, name: name.slice(0, 64) };
}

/** A server's name, or null when the bot is no longer in it. */
export async function serverName(serverId: string): Promise<string | null> {
  const answer = await call(`/guilds/${serverId}`).catch(() => null);
  const data = (answer?.data ?? {}) as { name?: unknown };
  return answer?.status === 200 && typeof data.name === "string" ? data.name : null;
}

function readRole(raw: unknown): DiscordRole | null {
  const role = (raw ?? {}) as Record<string, unknown>;
  if (typeof role.id !== "string" || !SNOWFLAKE.test(role.id)) return null;
  // Its place decides whether the bot can give it: one that is not Discord's whole number is not known, never
  // place 0 (which would sit below the bot and be offered) (CX-123 rule 24).
  if (typeof role.position !== "number" || !Number.isSafeInteger(role.position) || role.position < 0) return null;
  // A managed role (a bot's or an integration's) can never be given by hand: only Discord's own true or false says
  // which it is; anything else is not known and the role is not offered (review of Codex J on #2684).
  if (typeof role.managed !== "boolean") return null;
  return {
    id: role.id,
    name: typeof role.name === "string" ? role.name.slice(0, 100) : "",
    color: typeof role.color === "number" && Number.isSafeInteger(role.color) && role.color >= 0 ? role.color : 0,
    position: role.position,
    managed: role.managed,
  };
}

/** Every role of a server, and the position of the bot's own highest one; null when the server cannot be read. */
export async function serverRoles(serverId: string): Promise<{ roles: DiscordRole[]; botTop: number } | null> {
  const [roles, me] = await Promise.all([call(`/guilds/${serverId}/roles`).catch(() => null), call("/users/@me").catch(() => null)]);
  const botId = (me?.data as { id?: unknown } | null)?.id;
  if (roles?.status !== 200 || !Array.isArray(roles.data) || typeof botId !== "string") return null;
  const all = roles.data.map(readRole).filter((r): r is DiscordRole => r !== null);
  const member = await call(`/guilds/${serverId}/members/${botId}`).catch(() => null);
  // The bot's own roles decide what it can give: not read, or not a list of ids, is not known, never "none".
  const own = (member?.data as { roles?: unknown } | null)?.roles;
  if (member?.status !== 200 || !Array.isArray(own) || !own.every((id) => typeof id === "string")) return null;
  const held = new Set(own as string[]);
  const botTop = Math.max(0, ...all.filter((role) => held.has(role.id)).map((role) => role.position));
  return { roles: all, botTop };
}

/** Makes a role in the server, at the bottom, where the bot can always give it. */
export async function createRole(serverId: string, name: string): Promise<DiscordRole | null> {
  const answer = await call(`/guilds/${serverId}/roles`, { method: "POST", json: { name: name.slice(0, 100), mentionable: false, hoist: false }, reason: "Made from the Marktmorgen studio" }).catch(() => null);
  return answer && answer.status === 200 ? readRole(answer.data) : null;
}

export type Placed = "added" | "there" | "failed";

/** Puts a person in the server with these roles, using what they agreed to; "there" when they already were. */
export async function putMember(serverId: string, userId: string, accessToken: string, roles: string[], reason: string): Promise<Placed> {
  const answer = await call(`/guilds/${serverId}/members/${userId}`, { method: "PUT", json: { access_token: accessToken, roles }, reason }).catch(() => null);
  if (answer?.status === 201) return "added";
  if (answer?.status === 204 || answer?.status === 200) return "there";
  return "failed";
}

export type RoleChange = "ok" | "gone" | "failed";

function changed(answer: Answer | null): RoleChange {
  if (answer && answer.status >= 200 && answer.status < 300) return "ok";
  // 10007: the person is not in the server any more; 10011: the role is gone; 10004: the server is.
  // Only Discord's own whole number says so: a code of another shape ("10007", [10007]) is not known, never "gone",
  // which would forget somebody still in the server with their role (CX-123 rule 24).
  const code = (answer?.data as { code?: unknown } | null)?.code;
  if (answer?.status === 404 && (code === 10007 || code === 10011 || code === 10004)) return "gone";
  return "failed";
}

export async function giveRole(serverId: string, userId: string, roleId: string, reason: string): Promise<RoleChange> {
  return changed(await call(`/guilds/${serverId}/members/${userId}/roles/${roleId}`, { method: "PUT", reason }).catch(() => null));
}

export async function takeRole(serverId: string, userId: string, roleId: string, reason: string): Promise<RoleChange> {
  return changed(await call(`/guilds/${serverId}/members/${userId}/roles/${roleId}`, { method: "DELETE", reason }).catch(() => null));
}

/** Takes a person out of the server: only when the creator asked for it, once their access ended. */
export async function removeMember(serverId: string, userId: string, reason: string): Promise<RoleChange> {
  return changed(await call(`/guilds/${serverId}/members/${userId}`, { method: "DELETE", reason }).catch(() => null));
}

/**
 * The bot leaves the server: the creator disconnected it. Roles already given stay as they are. True only on
 * Discord's exact answer that it is out: a 2xx, or 404 with Discord's code 10004 (Unknown Guild) when it was no
 * longer there; anything else (no answer, a refusal, a 5xx, a 404 without that code, such as a proxy's page) is
 * false, and the bot may still be in the server (independent review of #2994).
 */
export async function leaveServer(serverId: string): Promise<boolean> {
  const answer = await call(`/users/@me/guilds/${serverId}`, { method: "DELETE" }).catch(() => null);
  if (answer && answer.status >= 200 && answer.status < 300) return true;
  // Discord's own whole number only, as in `changed`: "10004" or [10004] is not known (CX-123 rule 24).
  return answer?.status === 404 && (answer.data as { code?: unknown } | null)?.code === 10004;
}
