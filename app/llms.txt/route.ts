import { llmsText } from "@/lib/llms-text";
import { isPlatformHost, requestHost } from "@/lib/request-origin";

/** /llms.txt, generated from the code (lib/llms-text.ts); on this site only, never on a creator's own domain. */
export function GET(request: Request): Response {
  if (!isPlatformHost(requestHost(request))) return new Response("Not found", { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8" } });
  return new Response(llmsText(), {
    headers: {
      "Content-Type": "text/markdown; charset=utf-8",
      "Cache-Control": "public, max-age=3600",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
