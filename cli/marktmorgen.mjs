#!/usr/bin/env node
/**
 * marktmorgen: the command line for a creator's store, for people who
 * program and for AI agents that run commands (631 [AA1] (b), 616 [WP15](24),
 * unit 6, 2 November 2026).
 *
 * It is a thin client of the Marktmorgen MCP server (app/api/mcp/route.ts):
 * the tools it offers are whatever the server lists for the key, so the
 * command line, the creator's Claude or ChatGPT and the assistant in the
 * studio always do the same things, under the same key, limits and rules.
 * No dependency: Node 20 or later, and its own fetch.
 *
 * The key is read only from the MARKTMORGEN_API_KEY environment variable,
 * never from the command's arguments, where it would be kept in the shell's
 * history and shown to anyone listing processes. It is sent only to the
 * Marktmorgen address (MARKTMORGEN_URL may point a test at a local server;
 * any other address must be https).
 *
 *   marktmorgen tools                        what this key can do
 *   marktmorgen <tool> [--days 7|30|90] [--cursor <next>]
 *                                            one tool, its answer as JSON
 *   marktmorgen help                         this text
 *
 * Exit codes: 0 done; 1 the tool answered with an error; 2 the command or
 * the key was refused, or the server could not be reached.
 */

export const DEFAULT_URL = "https://marktmorgen.com";
export const USER_AGENT = "marktmorgen-cli/0.1.0";

export const HELP = `marktmorgen: your Marktmorgen store from the command line.

Set your API key first (make one in your studio, under API keys):
  export MARKTMORGEN_API_KEY=nl_live_...

Commands:
  marktmorgen tools                  List what your key can do.
  marktmorgen <tool> [options]       Run one tool and print its answer as JSON.
  marktmorgen help                   Show this text.

Options:
  --days 7|30|90                     The window, for tools that take one (30 when left out).
  --cursor <next>                    The next page, for list_products.

Examples:
  marktmorgen get_revenue_by_channel --days 7
  marktmorgen list_products
`;

/** The server's address, refused unless it is https (or a local server for a test). */
export function serverUrl(env) {
  let raw = String(env.MARKTMORGEN_URL || DEFAULT_URL);
  if (raw.length > 200) return null;
  while (raw.endsWith("/")) raw = raw.slice(0, -1);
  let url;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol !== "https:" && !(local && url.protocol === "http:")) return null;
  if (url.username || url.password) return null;
  return `${url.origin}/api/mcp`;
}

/** `--days 7 --cursor abc` as tool arguments; anything else is refused. */
export function parseArguments(args) {
  const out = {};
  for (let i = 0; i < args.length; i += 1) {
    const flag = args[i];
    const value = args[i + 1];
    if (flag === "--days") {
      if (!["7", "30", "90"].includes(value ?? "")) return { error: "--days takes 7, 30 or 90." };
      out.days = Number(value);
      i += 1;
    } else if (flag === "--cursor") {
      if (!value || value.startsWith("--")) return { error: "--cursor takes the `next` value of the page before." };
      out.cursor = value.slice(0, 200);
      i += 1;
    } else if (flag === "--key" || flag.startsWith("--key=") || /^nl_live_/.test(flag)) {
      return { error: "Never put the key in the command: set MARKTMORGEN_API_KEY instead, so it stays out of your shell history." };
    } else {
      return { error: `Unknown option: ${String(flag).slice(0, 40)}` };
    }
  }
  return { arguments: out };
}

let nextId = 1;

/** One JSON-RPC call to the MCP server. */
async function call(fetchImpl, url, key, method, params) {
  const response = await fetchImpl(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json", Authorization: `Bearer ${key}`, "User-Agent": USER_AGENT },
    body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, params }),
  });
  let body;
  try {
    body = await response.json();
  } catch {
    return { error: `The server answered ${response.status} without JSON.` };
  }
  if (body && body.error) return { error: typeof body.error.message === "string" ? body.error.message : "The server refused the request." };
  return { result: body ? body.result : undefined };
}

/**
 * Runs one command. Everything outside is passed in, so a test can run it
 * against the real route with a synthetic store.
 *
 * @param {string[]} argv
 * @param {{ env?: Record<string, string | undefined>, fetchImpl?: typeof fetch, write?: (text: string) => unknown, warn?: (text: string) => unknown }} [options]
 * @returns {Promise<number>}
 */
export async function run(argv, { env = {}, fetchImpl = globalThis.fetch, write = (t) => process.stdout.write(t), warn = (t) => process.stderr.write(t) } = {}) {
  const [command, ...rest] = argv;
  if (!command || command === "help" || command === "--help" || command === "-h") {
    write(HELP);
    return command ? 0 : 2;
  }
  const key = (env.MARKTMORGEN_API_KEY || "").trim();
  if (!/^nl_live_[0-9a-f]{40}$/.test(key)) {
    warn("Set MARKTMORGEN_API_KEY to one of your API keys (nl_live_...). Make one in your studio, under API keys.\n");
    return 2;
  }
  const url = serverUrl(env);
  if (!url) {
    warn("MARKTMORGEN_URL must be an https address.\n");
    return 2;
  }
  try {
    if (command === "tools") {
      if (rest.length) {
        warn("tools takes no options.\n");
        return 2;
      }
      const listed = await call(fetchImpl, url, key, "tools/list", {});
      if (listed.error) {
        warn(`${listed.error}\n`);
        return 2;
      }
      const tools = Array.isArray(listed.result?.tools) ? listed.result.tools : [];
      for (const tool of tools) {
        const takes = Object.keys(tool.inputSchema?.properties ?? {}).map((name) => ` [--${name}]`).join("");
        write(`${tool.name}${takes}\n  ${tool.description}\n`);
      }
      return 0;
    }
    if (!/^[a-z][a-z0-9_]{0,63}$/.test(command)) {
      warn(`Unknown command: ${command.slice(0, 40)}. Run: marktmorgen help\n`);
      return 2;
    }
    const parsed = parseArguments(rest);
    if (parsed.error) {
      warn(`${parsed.error}\n`);
      return 2;
    }
    const answered = await call(fetchImpl, url, key, "tools/call", { name: command, arguments: parsed.arguments });
    if (answered.error) {
      warn(`${answered.error}\n`);
      return 2;
    }
    const content = Array.isArray(answered.result?.content) ? answered.result.content : [];
    const text = content.filter((c) => c && c.type === "text").map((c) => c.text).join("\n");
    if (answered.result?.isError) {
      warn(`${text}\n`);
      return 1;
    }
    write(`${text}\n`);
    return 0;
  } catch {
    warn("Marktmorgen could not be reached. Check your connection and try again.\n");
    return 2;
  }
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("/marktmorgen")) {
  run(process.argv.slice(2), { env: process.env }).then((code) => process.exit(code));
}
