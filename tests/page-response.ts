/**
 * What an App Router page really sends to the browser, measured in a test
 * (C3-80, 4 November 2026; the review of claude3/orders-page-bounds found that
 * renderToStaticMarkup counts the HTML alone).
 *
 * A page of the App Router answers with three things, and each is counted here:
 *
 *   - its HTML, drawn by React DOM as the server draws it for the first paint
 *     (renderToString, which keeps the <!-- --> marks between adjacent texts
 *     that renderToStaticMarkup leaves out);
 *   - its RSC payload, the whole tree serialized once more for the browser to
 *     take over: drawn here by React's own Flight server, the one Next ships
 *     (next/dist/compiled/react-server-dom-webpack, under next/dist/compiled/react's
 *     react-server build, as Next runs it), with every component of a
 *     "use client" file sent as a reference with its props, and embedded the
 *     way Next embeds it (next/dist/server/app-render/use-flight-response.js):
 *     each chunk in its own <script nonce="…">self.__next_f.push([1,"…"])</script>,
 *     JSON-escaped and then HTML-escaped (& < > as & < >). Each
 *     row is counted as its own script, more than Next ever writes;
 *   - the shell no page here can draw by itself: the root layout and the store
 *     layout, the document's head with the whole stylesheet inlined
 *     (next.config.ts, inlineCss), the scripts with their nonces, the router's
 *     own rows of the payload and each client component's chunk list. It is
 *     SHELL_BYTES, measured on 4 November 2026 on a local production build
 *     (next build --webpack, next start) of this branch: the orders page of a
 *     synthetic store with its chat on, opened with a link that lists nothing,
 *     answered 403,137 bytes, of which the page's own HTML was 1,636 and its
 *     payload rows 2,737 (unescaped, the least they add): 398,764 bytes of
 *     shell, 178,341 of them the inlined stylesheet. Taken as 400,000, above
 *     the 160,000 allowed before it was measured.
 *
 * Only the measuring is here; what a page may send is held by its own test.
 */
import { createRequire } from "node:module";
import { join } from "node:path";
import { Writable } from "node:stream";
import type { ReactElement } from "react";
import { renderToString } from "react-dom/server";

/** The shell besides the page's own tree: layouts, head with the inlined stylesheet, scripts, the router's rows (measured; see above). */
export const SHELL_BYTES = 400_000;
/** The most bytes a script's nonce attribute takes (nonce="…", a base64 nonce of at most 64 characters). */
const NONCE = 64;
/** What one embedded chunk adds around its data: <script nonce="…">self.__next_f.push( and )</script>. */
const SCRIPT_AROUND = `<script nonce="${"n".repeat(NONCE)}">self.__next_f.push(`.length + ")</script>".length;

/** The chunk list a client reference carries in the payload: generous, ten chunks of a production build's names. */
const CHUNKS = Array.from({ length: 10 }, (_, i) => `static/chunks/${i}${"0".repeat(15)}-${"a".repeat(16)}.js`);

type Flight = { renderToPipeableStream: (model: unknown, manifest: unknown, options: { onError: (error: unknown) => void }) => { pipe: (to: Writable) => void } };
let flight: Flight | null = null;

/**
 * React's Flight server as Next runs it: its "react" and "react-dom" are the
 * react-server builds Next ships. Loaded once, outside the test's bundle.
 */
function flightServer(): Flight {
  if (flight) return flight;
  const root = process.cwd();
  const compiled = join(root, "node_modules/next/dist/compiled");
  const serverReact = join(compiled, "react/react.react-server.js");
  const serverDom = join(compiled, "react-dom/react-dom.react-server.js");
  const swap: Record<string, string> = { react: serverReact, "next/dist/compiled/react": serverReact, "react-dom": serverDom, "next/dist/compiled/react-dom": serverDom };
  const load = createRequire(join(root, "package.json"));
  const Module = load("node:module") as { _resolveFilename: (request: string, parent: { filename?: string } | null, ...rest: unknown[]) => string };
  const resolve = Module._resolveFilename;
  const before = process.env.NODE_ENV;
  Module._resolveFilename = function (request, parent, ...rest) {
    const from = parent?.filename ?? "";
    if (swap[request] && /react-server-dom-webpack|compiled[\\/]react-dom[\\/]|compiled[\\/]react[\\/]/.test(from)) return swap[request];
    return resolve.call(this, request, parent, ...rest);
  };
  try {
    (process.env as Record<string, string>).NODE_ENV = "production";
    flight = load(join(compiled, "react-server-dom-webpack/cjs/react-server-dom-webpack-server.node.production.js")) as Flight;
  } finally {
    Module._resolveFilename = resolve;
    (process.env as Record<string, string | undefined>).NODE_ENV = before;
  }
  return flight;
}

const CLIENT = Symbol.for("react.client.reference");
const manifest: Record<string, { id: string; chunks: string[]; name: string }> = {};

/**
 * Marks each component of a "use client" file as a client reference, as Next's
 * bundler does: Flight then sends it as a reference with its props, never runs
 * it. React DOM still draws it for the HTML. Every name must be one of a
 * "use client" file's exports (the test that calls this checks the files).
 */
export function clientComponents(components: Record<string, unknown>): void {
  for (const [name, component] of Object.entries(components)) {
    const target = component as Record<string, unknown>;
    if (target.$$typeof === CLIENT) continue;
    const id = `${name}#${Object.keys(manifest).length}`;
    Object.assign(target, { $$typeof: CLIENT, $$id: id, $$async: false });
    manifest[id] = { id: `${Object.keys(manifest).length + 1000}`, chunks: CHUNKS, name };
  }
}

/** Next's own escaping of a script's JSON (next/dist/shared/lib/htmlescape.js, htmlEscapeJsonString). */
const htmlEscapeJson = (text: string) =>
  text.replace(/[&><\u2028\u2029]/g, (c) => ({ "&": "\\u0026", ">": "\\u003e", "<": "\\u003c", "\u2028": "\\u2028", "\u2029": "\\u2029" })[c] as string);

/** The RSC payload of a tree, as Flight writes it, chunk by chunk. */
export async function payloadOf(tree: ReactElement): Promise<string[]> {
  const chunks: string[] = [];
  const errors: unknown[] = [];
  await new Promise<void>((resolve, reject) => {
    const stream = flightServer().renderToPipeableStream(tree, manifest, { onError: (error) => void errors.push(error) });
    stream.pipe(
      new Writable({
        write(chunk, _encoding, done) {
          chunks.push(Buffer.from(chunk).toString("utf8"));
          done();
        },
        final(done) {
          done();
          resolve();
        },
        destroy(error, done) {
          if (error) reject(error);
          done(error);
        },
      }),
    );
  });
  if (errors.length) throw errors[0];
  return chunks;
}

/** How many rows a payload holds, at the most: each line, and each text row (id:T<length>,…), which ends without one. */
function rowsOf(payload: string): number {
  return (payload.match(/\n/g) ?? []).length + (payload.match(/(?:^|\n)[0-9a-f]+:T[0-9a-f]+,/g) ?? []).length + 1;
}

/** What the payload weighs embedded in the HTML: every row in a script of its own, escaped as Next escapes it. */
export function embeddedBytes(chunks: string[]): number {
  const payload = chunks.join("");
  const data = Buffer.byteLength(htmlEscapeJson(JSON.stringify([1, payload])));
  return data + (rowsOf(payload) + chunks.length) * (SCRIPT_AROUND + `[1,""]`.length);
}

export type ResponseSize = { html: number; payload: number; shell: number; total: number };

/**
 * What a page's answer weighs: its HTML, its RSC payload embedded as Next
 * embeds it, and SHELL_BYTES. The tree is the page's own element, its async
 * page component already awaited; components of "use client" files must have
 * been named with clientComponents first.
 */
export async function responseSize(tree: ReactElement): Promise<ResponseSize> {
  const html = Buffer.byteLength(renderToString(tree));
  const payload = embeddedBytes(await payloadOf(tree));
  return { html, payload, shell: SHELL_BYTES, total: html + payload + SHELL_BYTES };
}
