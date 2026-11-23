/**
 * Issue #4482 (Codex X4, LOW): reading a business's website for an outreach pitch (lib/outreach.ts readSite) asked
 * for the front page first and only then for robots.txt, so a site whose robots.txt says
 * `User-agent: MarktmorgenOutreach / Disallow: /` had its front page read anyway, although the answer was
 * "unreadable". Now robots.txt is asked first, and a site that closes "/" to this reader is never read. A front page
 * that moves to another origin still has that origin's robots.txt asked, as before; on the same origin, robots.txt
 * is asked once, as before.
 *
 * Synthetic only: a page reader that answers from a fixed list and records every address asked.
 */
import { readSite } from "@/lib/outreach";
import { done, is, part } from "./check";

const HOME = `<html><head><title>Copper &amp; Oak</title></head><body><a href="/partners">Partners</a> hello@copperoak.com</body></html>`;

function reader(pages: Record<string, string>, moves: Record<string, string> = {}) {
  const asked: string[] = [];
  const read = async (url: string) => {
    asked.push(url);
    const at = moves[url] ?? url;
    return at in pages ? { url: at, html: pages[at] } : null;
  };
  return Object.assign(read, { asked });
}

async function main(): Promise<void> {
  part("A site that closes / to this reader: robots.txt first, the front page never asked");
  const closed = reader({ "https://copperoak.com/": HOME, "https://copperoak.com/robots.txt": "User-agent: MarktmorgenOutreach\nDisallow: /\n" });
  const shut = await readSite("copperoak.com", closed);
  is("unreadable", shut.ok ? "read" : shut.reason, "unreadable");
  is("robots.txt asked first", closed.asked[0], "https://copperoak.com/robots.txt");
  is("the front page never asked", closed.asked.includes("https://copperoak.com/"), false);

  part("Controls: an open site is read, robots.txt asked once on the same origin");
  const open = reader({ "https://copperoak.com/": HOME, "https://copperoak.com/robots.txt": "User-agent: *\nDisallow: /private\n", "https://copperoak.com/partners": "<html>partnerships@copperoak.com</html>" });
  const read = await readSite("copperoak.com", open);
  is("read", read.ok, true);
  is("robots.txt asked first, and once", [open.asked[0], open.asked.filter((u) => u.endsWith("/robots.txt")).length], ["https://copperoak.com/robots.txt", 1]);

  part("A front page that moves to another origin: that origin's robots.txt is asked too");
  const moved = reader(
    { "https://www.copperoak.com/": HOME, "https://copperoak.com/robots.txt": "User-agent: *\nDisallow:\n", "https://www.copperoak.com/robots.txt": "User-agent: MarktmorgenOutreach\nDisallow: /\n" },
    { "https://copperoak.com/": "https://www.copperoak.com/" },
  );
  const away = await readSite("copperoak.com", moved);
  is("the new origin closes itself: unreadable", away.ok ? "read" : away.reason, "unreadable");
  is("its robots.txt was asked", moved.asked.includes("https://www.copperoak.com/robots.txt"), true);

  done();
}
main().catch((error) => {
  console.error(error);
  process.exit(1);
});
