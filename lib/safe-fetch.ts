/**
 * Fetching an address a creator typed, without letting it reach inside.
 *
 * Two features send requests to addresses a creator gives us: the calendars
 * read for busy times (lib/calendar-sync.ts) and the webhooks sent when
 * something happens in a store (lib/webhooks.ts). Two more go through here
 * although their hosts are fixed lists of our own choosing: the email
 * platforms a creator connects (lib/email-platforms.ts) and the push
 * services a phone subscribed through (lib/web-push.ts), because the address
 * of a push subscription is written by a browser, which a person controls.
 * An address typed into a
 * form is an address anybody could have typed, and a server that fetches it
 * without looking is a server that can be asked to fetch its own insides —
 * a cloud's metadata service, a database on the private network, a port on
 * the same machine. So every request made here passes the same checks:
 *
 *   - https only, on port 443 or a port above 1023, with no user name or
 *     password in the address, and a name that looks like a public one;
 *   - the name is looked up here, every address it has is checked, and the
 *     request is made to the address that was checked, not to a second
 *     lookup that could answer differently. An address in any private,
 *     loopback, link-local, shared, documentation or multicast range, v4 or
 *     v6 (including v4 dressed as v6), is refused, and so is a name with
 *     even one such address among its answers;
 *   - a redirect is a new address and passes the same checks, at most three
 *     times; a POST never follows one; a redirect to another origin (scheme,
 *     host or port) leaves the caller's credentials behind (sensitiveHeader),
 *     as browsers do with Authorization, and they stay behind for every hop
 *     after it;
 *   - the whole exchange has a deadline, every name lookup included, and
 *     the answer a size cap, counted as it arrives rather than trusted from
 *     the header.
 *
 * Nothing here is a dependency: Node's own https, with the connection pinned
 * to the address that was checked.
 */
import { lookup as dnsLookup } from "node:dns/promises";
import https from "node:https";
import { type LookupFunction, isIP } from "node:net";
import { gunzipSync, inflateSync } from "node:zlib";

export type SafeFetchProblem =
  | "address"
  | "scheme"
  | "port"
  | "private"
  | "dns"
  | "redirect"
  | "too_big"
  | "timeout"
  | "network";

export class SafeFetchError extends Error {
  readonly problem: SafeFetchProblem;
  /** For too_big: the status the address had already answered with, when it is known; a caller may judge by it. */
  readonly status?: number;

  constructor(problem: SafeFetchProblem, message: string, status?: number) {
    super(message);
    this.problem = problem;
    if (Number.isSafeInteger(status)) this.status = status;
  }
}

export type SafeResponse = {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
  /** The address that answered, after any redirects. */
  url: string;
};

/** Looks a name up. Every answer is checked by the caller, whatever this returns. */
export type Resolver = (host: string) => Promise<{ address: string; family: number }[]>;

export type SafeFetchOptions = {
  method?: "GET" | "POST";
  headers?: Record<string, string>;
  /** Text, or bytes (an encrypted push message). */
  body?: string | Buffer;
  /** The largest answer read, in bytes. */
  maxBytes: number;
  /** The whole exchange, redirects included, in milliseconds. */
  timeoutMs: number;
  /** Redirects followed on a GET. A POST follows none. */
  maxRedirects?: number;
  /** Replaces the DNS lookup; its answers are still checked. For tests. */
  resolve?: Resolver;
  /** Replaces the connection pool; the checks run first all the same. For tests. */
  agent?: https.Agent;
};

const defaultResolve: Resolver = (host) => dnsLookup(host, { all: true, verbatim: true });

// ---- Which addresses are public ---------------------------------------------

const V4_SYNTAX = /^\d{1,3}(\.\d{1,3}){3}$/;

function v4Number(ip: string): number {
  return ip.split(".").reduce((n, part) => n * 256 + Number(part), 0);
}

/** Ranges no request of ours should ever reach, as [first address, prefix length]. */
const V4_BLOCKED: [string, number][] = [
  ["0.0.0.0", 8], // "this network"
  ["10.0.0.0", 8], // private
  ["100.64.0.0", 10], // shared address space (carrier NAT)
  ["127.0.0.0", 8], // loopback
  ["169.254.0.0", 16], // link-local, where cloud metadata services live
  ["172.16.0.0", 12], // private
  ["192.0.0.0", 24], // protocol assignments
  ["192.0.2.0", 24], // documentation
  ["192.88.99.0", 24], // 6to4 relay
  ["192.168.0.0", 16], // private
  ["198.18.0.0", 15], // benchmarking
  ["198.51.100.0", 24], // documentation
  ["203.0.113.0", 24], // documentation
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved, and the broadcast address
];

function isPublicV4(ip: string): boolean {
  if (!V4_SYNTAX.test(ip) || ip.split(".").some((p) => Number(p) > 255)) return false;
  const n = v4Number(ip);
  return !V4_BLOCKED.some(([base, bits]) => {
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    return ((n & mask) >>> 0) === ((v4Number(base) & mask) >>> 0);
  });
}

/** The eight 16-bit groups of a v6 address, or null when it is not one. */
function v6Groups(ip: string): number[] | null {
  if (ip.includes("%")) return null; // a zone id names a local interface
  let text = ip.toLowerCase();
  let tail: number[] = [];
  if (text.includes(".")) {
    const colon = text.lastIndexOf(":");
    const v4 = text.slice(colon + 1);
    if (!V4_SYNTAX.test(v4) || v4.split(".").some((p) => Number(p) > 255)) return null;
    const n = v4Number(v4);
    tail = [Math.floor(n / 65536), n % 65536];
    text = text.slice(0, colon + 1);
    if (!text.endsWith("::")) text = text.slice(0, -1);
  }
  const want = 8 - tail.length;
  const parts = text.split("::");
  if (parts.length > 2) return null;
  const head = parts[0] ? parts[0].split(":") : [];
  const rest = parts.length === 2 && parts[1] ? parts[1].split(":") : [];
  if (parts.length === 1 && head.length !== want) return null;
  // "::" stands for at least one group of zeros.
  if (parts.length === 2 && head.length + rest.length >= want) return null;
  const hex = (g: string) => (/^[0-9a-f]{1,4}$/.test(g) ? parseInt(g, 16) : NaN);
  const zeros = parts.length === 2 ? new Array<number>(want - head.length - rest.length).fill(0) : [];
  const groups = [...head.map(hex), ...zeros, ...rest.map(hex), ...tail];
  return groups.length === 8 && !groups.some(Number.isNaN) ? groups : null;
}

function isPublicV6(ip: string): boolean {
  const g = v6Groups(ip);
  if (!g) return false;
  const v4At = (hi: number, lo: number) => `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
  // v4 written as v6 — mapped (::ffff:a.b.c.d) and the NAT64 prefix — is
  // judged as the v4 address it carries.
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) return isPublicV4(v4At(g[6], g[7]));
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) return isPublicV4(v4At(g[6], g[7]));
  // Only global unicast (2000::/3) is public, less the parts of it that are
  // not: documentation, Teredo and 6to4, which tunnel to addresses unseen.
  if ((g[0] & 0xe000) !== 0x2000) return false;
  if (g[0] === 0x2001 && g[1] === 0x0db8) return false;
  if (g[0] === 0x2001 && g[1] === 0x0000) return false;
  if (g[0] === 0x2002) return false;
  return true;
}

/** Whether an IP address, v4 or v6, is one a request of ours may reach. */
export function isPublicAddress(ip: string): boolean {
  const kind = isIP(ip);
  if (kind === 4) return isPublicV4(ip);
  if (kind === 6) return isPublicV6(ip);
  return false;
}

// ---- Which addresses may be asked for ---------------------------------------

/** Names that only mean something inside a network. */
const LOCAL_NAME = /(^|\.)(localhost|local|localdomain|internal|intranet|lan|home|corp|private|test|invalid|example|arpa)$/i;

/**
 * Reads a typed address into one that may be fetched, or says why not.
 * `webcal://`, which calendar apps hand out, is the same address over https.
 */
export function checkUrl(raw: string): URL {
  let text = raw.trim();
  if (/^webcals?:\/\//i.test(text)) text = text.replace(/^webcals?:\/\//i, "https://");
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new SafeFetchError("address", "That is not a web address.");
  }
  if (url.protocol !== "https:") throw new SafeFetchError("scheme", "Only https:// addresses are accepted.");
  if (url.username || url.password) throw new SafeFetchError("address", "An address with a user name or password in it is not accepted.");
  const port = url.port ? Number(url.port) : 443;
  if (port !== 443 && port < 1024) throw new SafeFetchError("port", "Only port 443, or a port above 1023, is accepted.");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (isIP(host)) {
    if (!isPublicAddress(host)) throw new SafeFetchError("private", "That address is on a private or local network.");
  } else if (!host.includes(".") || LOCAL_NAME.test(host.replace(/\.$/, ""))) {
    throw new SafeFetchError("private", "That address is on a private or local network.");
  }
  return url;
}

/** The refusal for an exchange that ran out of time, wherever it was. */
function tooLong(): SafeFetchError {
  return new SafeFetchError("timeout", "The address took too long to answer.");
}

/**
 * The lookup, given only the time left until the deadline: a nameserver that
 * stays silent is refused as a timeout, like an address that does, and an
 * answer arriving later is dropped (Claude 6 audit R27, finding 2;
 * tests/safe-fetch-dns-deadline.test.ts). lib/domain-proof.ts races its own
 * lookup the same way. The timer is cleared whichever side wins.
 */
async function lookupBefore(host: string, resolve: Resolver, deadline: number): Promise<{ address: string; family: number }[]> {
  const left = deadline - Date.now();
  if (left <= 0) throw tooLong();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(tooLong()), left);
  });
  try {
    return await Promise.race([resolve(host), expired]);
  } finally {
    clearTimeout(timer);
  }
}

/** Every address the name has, all of them public, the first one to connect to. */
async function publicAddressFor(host: string, resolve: Resolver, deadline: number): Promise<{ address: string; family: number }> {
  if (isIP(host)) {
    if (!isPublicAddress(host)) throw new SafeFetchError("private", "That address is on a private or local network.");
    return { address: host, family: isIP(host) };
  }
  let answers: { address: string; family: number }[];
  try {
    answers = await lookupBefore(host, resolve, deadline);
  } catch (error) {
    if (error instanceof SafeFetchError && error.problem === "timeout") throw error;
    throw new SafeFetchError("dns", "That name could not be found.");
  }
  if (!answers.length) throw new SafeFetchError("dns", "That name could not be found.");
  // One private answer among public ones is how a name is made to point
  // inside on the second try, so a single one refuses the lot.
  if (answers.some((a) => !isPublicAddress(a.address))) {
    throw new SafeFetchError("private", "That name points to a private or local network.");
  }
  return answers[0];
}

// ---- The request ------------------------------------------------------------

/**
 * Whether a header carries a credential, so it never follows a redirect to
 * another origin: Authorization, Proxy-Authorization, Cookie, and any name
 * holding "token", "secret", "key" or "signature", in any case. Security
 * audit 506 [SG1], MM-SA-28 (tests/safe-fetch-redirect.test.ts).
 */
export function sensitiveHeader(name: string): boolean {
  const lower = name.toLowerCase();
  // By what the name holds, not its exact spelling: X-Authorization, X-Auth, X-Cookie, X-Session-Id, X-Hmac, X-Jwt, a bearer, a pass,
  // a CSRF or XSRF token and a DPoP proof carry credentials too.
  return /auth|cookie|token|secret|key|signature|session|credential|pass|hmac|jwt|bearer|csrf|xsrf|dpop/.test(lower);
}

/** The headers without any credential, for a request to another origin. */
function withoutCredentials(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(headers).filter(([name]) => !sensitiveHeader(name)));
}

/** A lookup that answers with the one address already checked, whatever it is asked. */
function pinnedLookup(pinned: { address: string; family: number }): LookupFunction {
  return ((_host: string, opts: { all?: boolean }, callback: (...args: unknown[]) => void) => {
    if (opts && opts.all) callback(null, [{ address: pinned.address, family: pinned.family }]);
    else callback(null, pinned.address, pinned.family);
  }) as unknown as LookupFunction;
}

function once(
  url: URL,
  pinned: { address: string; family: number },
  options: SafeFetchOptions,
  deadline: number,
): Promise<{ status: number; headers: Record<string, string>; body: Buffer }> {
  return new Promise((resolvePromise, reject) => {
    const left = deadline - Date.now();
    if (left <= 0) {
      reject(new SafeFetchError("timeout", "The address took too long to answer."));
      return;
    }
    const body = options.body ?? null;
    const request = https.request(
      {
        protocol: "https:",
        hostname: url.hostname.replace(/^\[|\]$/g, ""),
        servername: isIP(url.hostname.replace(/^\[|\]$/g, "")) ? undefined : url.hostname,
        port: url.port ? Number(url.port) : 443,
        path: `${url.pathname}${url.search}`,
        method: options.method ?? "GET",
        agent: options.agent,
        headers: {
          "Accept-Encoding": "gzip, deflate",
          ...(options.headers ?? {}),
          ...(body !== null ? { "Content-Length": String(Buffer.byteLength(body)) } : {}),
        },
        // The connection goes to the address that was checked, whatever a
        // second lookup of the same name would say now.
        lookup: pinnedLookup(pinned),
      },
      (response) => {
        const declared = Number(response.headers["content-length"] ?? "0");
        if (declared > options.maxBytes) {
          request.destroy(new SafeFetchError("too_big", "The answer is larger than we read.", response.statusCode));
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        response.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > options.maxBytes) {
            request.destroy(new SafeFetchError("too_big", "The answer is larger than we read.", response.statusCode));
            return;
          }
          chunks.push(chunk);
        });
        response.on("end", () => {
          const headers: Record<string, string> = {};
          for (const [name, value] of Object.entries(response.headers)) {
            if (typeof value === "string") headers[name] = value;
            else if (Array.isArray(value)) headers[name] = value.join(", ");
          }
          let raw = Buffer.concat(chunks);
          const encoding = (headers["content-encoding"] ?? "").toLowerCase();
          try {
            if (encoding === "gzip") raw = gunzipSync(raw, { maxOutputLength: options.maxBytes });
            else if (encoding === "deflate") raw = inflateSync(raw, { maxOutputLength: options.maxBytes });
          } catch {
            reject(new SafeFetchError("too_big", "The answer could not be unpacked within the size we read.", response.statusCode));
            return;
          }
          resolvePromise({ status: response.statusCode ?? 0, headers, body: raw });
        });
        response.on("error", (error) => reject(error));
      },
    );
    const timer = setTimeout(() => request.destroy(new SafeFetchError("timeout", "The address took too long to answer.")), left);
    request.on("close", () => clearTimeout(timer));
    request.on("error", (error) => {
      clearTimeout(timer);
      reject(error instanceof SafeFetchError ? error : new SafeFetchError("network", "The address could not be reached."));
    });
    if (body !== null) request.write(body);
    request.end();
  });
}

/**
 * One request to an address somebody typed, with every check above. Throws
 * a SafeFetchError saying which check refused it, or why it did not answer;
 * an answer of any status comes back for the caller to judge.
 */
export async function safeFetch(raw: string, options: SafeFetchOptions): Promise<SafeResponse> {
  const resolve = options.resolve ?? defaultResolve;
  const deadline = Date.now() + options.timeoutMs;
  const hops = options.method === "POST" ? 0 : options.maxRedirects ?? 3;
  let url = checkUrl(raw);
  let headers = options.headers;
  for (let hop = 0; ; hop += 1) {
    // The deadline runs from the start, so the lookup of each hop, redirects
    // included, gets only the time that is left.
    const pinned = await publicAddressFor(url.hostname.replace(/^\[|\]$/g, ""), resolve, deadline);
    const answer = await once(url, pinned, { ...options, headers }, deadline);
    if (answer.status >= 300 && answer.status < 400 && answer.headers.location) {
      if (hop >= hops) throw new SafeFetchError("redirect", options.method === "POST" ? "The address answered with a redirect, which is not followed." : "The address redirected too many times.");
      let next: string;
      try {
        next = new URL(answer.headers.location, url).toString();
      } catch {
        throw new SafeFetchError("redirect", "The address redirected somewhere unreadable.");
      }
      const from = url.origin;
      url = checkUrl(next);
      // Another origin is somebody else: the caller's credentials stay
      // behind, and once left they are not picked up again.
      if (url.origin !== from && headers) headers = withoutCredentials(headers);
      continue;
    }
    return { ...answer, url: url.toString() };
  }
}

/** A sentence for the creator about why an address was refused or did not answer. */
export function problemWords(error: unknown): string {
  if (error instanceof SafeFetchError) return error.message;
  return "The address could not be reached.";
}
