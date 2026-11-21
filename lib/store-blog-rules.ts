/** Pure blog rendering shared by the editor and public pages; no server readers. */
import { type Block, aboutBlocks, cleanAbout } from "@/lib/product-about";

export const MAX_POST_BODY = 20_000;

/** A post cut into what the page draws: headings, paragraphs and lists. */
export type PostBlock = Block | { kind: "heading"; text: string };

export function postBlocks(body: string): PostBlock[] {
  const out: PostBlock[] = [];
  let run: string[] = [];
  const flush = () => {
    if (run.length) out.push(...aboutBlocks(run.join("\n"), MAX_POST_BODY));
    run = [];
  };
  for (const line of cleanAbout(body, MAX_POST_BODY).split("\n")) {
    const heading = /^##\s+(.+)$/.exec(line.trim());
    if (heading) {
      flush();
      out.push({ kind: "heading", text: heading[1].trim().slice(0, 140) });
    } else {
      run.push(line);
    }
  }
  flush();
  return out;
}
