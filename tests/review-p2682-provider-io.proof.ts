/**
 * Review proof for #2682. domainStatus cannot distinguish a missing domain
 * from an unavailable project, and returns null in either case. Its 404 path
 * therefore must not add a second supplier read whose result is discarded.
 */
import { domainStatus } from "@/lib/domains";
import { done, is, part } from "./check";

process.env.VERCEL_API_TOKEN = "test-token";
process.env.VERCEL_PROJECT_ID = "prj_test123";

const seen: string[] = [];
globalThis.fetch = (async (input: RequestInfo | URL) => {
  const url = new URL(String(input));
  seen.push(url.pathname);
  if (url.pathname.endsWith("/domains/gone.example.com")) {
    return Response.json({}, { status: 404 });
  }
  return Response.json({ id: "prj_test123" });
}) as typeof fetch;

async function main(): Promise<void> {
  part("A status reader does not pay to distinguish two identical outcomes");
  is("a missing domain remains unknown", await domainStatus("gone.example.com", { sid: "s_review" }), null);
  is("only the requested domain is read", seen, ["/v9/projects/prj_test123/domains/gone.example.com"]);
  done();
}

void main();
