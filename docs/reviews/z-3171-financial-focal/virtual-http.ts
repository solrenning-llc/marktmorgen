/** Synthetic loopback facade derived from G5816809859; real author callback
 * and Blob SDK, no sockets. Every dispatch shares the pre-graph mock budget. */
type RequestLike = { url: string; on(name: string, fn: unknown): RequestLike };
type ResponseLike = { setHeader(name: string, value: string): void; end(body: string): void };
let handler: ((req: RequestLike, res: ResponseLike) => void) | null = null;
let dispatched = 0;
const port = 18171;
export function createServer(fn: (req: RequestLike, res: ResponseLike) => void) {
  handler = fn;
  return {
    listen(requested: number, host: string, callback: () => void) {
      if (requested !== 0 || host !== "127.0.0.1") throw Error("Virtual listen refused");
      callback();
    },
    address() { return { port, address: "127.0.0.1", family: "IPv4" }; },
    close() { handler = null; },
  };
}
export async function fetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (url.origin !== `http://127.0.0.1:${port}` || !handler) throw Error("Virtual external request denied");
  (globalThis as unknown as { __zMock(): void }).__zMock();
  dispatched += 1;
  const raw = String(init?.body ?? "");
  return new Promise<Response>((resolve, reject) => {
    let data: ((chunk: Buffer) => void) | undefined;
    let end: (() => void) | undefined;
    const headers: Record<string, string> = {};
    const req: RequestLike = {
      url: url.pathname + url.search,
      on(name, fn) {
        if (typeof fn !== "function") throw Error("Unknown virtual event callback");
        if (name === "data") data = fn as (chunk: Buffer) => void;
        else if (name === "end") end = fn as () => void;
        else throw Error("Unknown virtual event");
        return req;
      },
    };
    const res: ResponseLike = {
      setHeader(name, value) { headers[name] = value; },
      end(body) { resolve(new Response(body, { status: 200, headers })); },
    };
    try { handler!(req, res); data?.(Buffer.from(raw)); end?.(); } catch (error) { reject(error); }
  });
}
(globalThis as unknown as { __zVirtualFetch: typeof fetch }).__zVirtualFetch = fetch;
process.on("exit", () => console.log("Z_VIRTUAL_DISPATCH", dispatched));
