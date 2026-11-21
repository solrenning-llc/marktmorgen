/**
 * Archive a link (423 [LT1], unit 1; added 10 November 2026): through the
 * real links route with the creator's own session, a link or a heading is
 * kept back from the store page without being removed: its title, address,
 * times, spotlight and place stay; an edit keeps it archived; "Show again"
 * brings it back within its own times, never clearing them, so one whose end
 * has passed stays hidden; and the studio says where it stands in words.
 */
import { readFileSync } from "node:fs";
import { NextRequest } from "next/server";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { claimHandle, storeForEmail } from "@/lib/store";
import { linkShowing, linkWhen, parseStoreLinks, showingLinks, type StoreLink } from "@/lib/store-link";
import { archiveDoneWords } from "@/components/link-editor";
import { POST as links } from "@/app/api/store/links/route";
import "./redis-stub";
import { done, is, part } from "./check";

const OWNER = "link-archive@example.com";
const ORIGIN = "https://marktmorgen.com";
const at = (iso: string) => Date.parse(iso);

async function main(): Promise<void> {
  part("The rules");
  const base: StoreLink = { id: "a1", title: "My podcast", url: "https://example.com/podcast", addedAt: "" };
  const archived: StoreLink = { ...base, archived: true };
  is("an archived link is not on the page, whatever its times", [linkShowing(archived), linkShowing({ ...archived, from: "2026-01-01T00:00:00.000Z", until: "2099-01-01T00:00:00.000Z" }, at("2026-06-01T00:00:00Z"))], [false, false]);
  is("the studio reads it as archived before its times", [linkWhen(archived), linkWhen({ ...archived, until: "2020-06-01T00:00:00.000Z" })], ["archived", "archived"]);
  const heading: StoreLink = { id: "h1", title: "Listen", url: "", addedAt: "", header: true };
  is("visitors see the others, and a heading left with nothing under it goes too", showingLinks([heading, archived, { ...base, id: "a2" }]).map((l) => l.id), ["h1", "a2"]);
  is("and with only archived links under it, the heading goes", showingLinks([heading, archived]).map((l) => l.id), []);
  is("kept through storage, for a link and a heading; anything but true is not archived", parseStoreLinks([{ ...base, archived: true }, { ...heading, archived: true }, { ...base, id: "a3", archived: "yes" }]).map((l) => l.archived ?? false), [true, true, false]);

  part("Through the route");
  await claimHandle(OWNER, "linkarchive", "Link archive", "");
  const session = await openSession(OWNER);
  const headers = { "content-type": "application/json", cookie: `${SESSION_COOKIE}=${session}` };
  const post = async (body: unknown) => {
    const response = await links(new NextRequest(`${ORIGIN}/api/store/links`, { method: "POST", headers, body: JSON.stringify(body) }));
    return { status: response.status, data: (await response.json()) as { ok?: boolean; error?: string; links?: StoreLink[] } };
  };
  const from = "2026-01-01T12:00:00.000Z", until = "2099-01-01T12:00:00.000Z";
  await post({ action: "add", title: "My podcast", url: "https://example.com/podcast", spotlight: true, from, until });
  await post({ action: "add", title: "My shop", url: "https://example.com/shop" });
  const [link, other] = (await storeForEmail(OWNER))!.links;
  const archivedNow = await post({ action: "archive", id: link.id });
  const kept = (await storeForEmail(OWNER))!.links;
  is("archived: kept in its place with everything it had", [archivedNow.status, kept.length, kept[0].id, kept[0].archived, kept[0].title, kept[0].url, kept[0].spotlight, kept[0].from, kept[0].until], [200, 2, link.id, true, "My podcast", "https://example.com/podcast", true, from, until]);
  is("and off the page visitors see; the other stays", showingLinks(kept).map((l) => l.id), [other.id]);
  await post({ action: "edit", id: link.id, title: "My podcast, season 2", url: "https://example.com/podcast", spotlight: true, from, until });
  const edited = (await storeForEmail(OWNER))!.links[0];
  is("an edit keeps it archived", [edited.title, edited.archived], ["My podcast, season 2", true]);
  await post({ action: "unarchive", id: link.id });
  const back = (await storeForEmail(OWNER))!.links[0];
  is("shown again: within its own times, which are kept", [back.archived ?? false, back.from, back.until, back.spotlight, showingLinks((await storeForEmail(OWNER))!.links).map((l) => l.id)], [false, from, until, true, [link.id, other.id]]);
  await post({ action: "edit", id: other.id, title: "My shop", url: "https://example.com/shop", until: "2021-01-01T00:00:00.000Z" });
  await post({ action: "archive", id: other.id });
  await post({ action: "unarchive", id: other.id });
  const ended = (await storeForEmail(OWNER))!.links[1];
  is("a link whose end has passed stays hidden when shown again: its time is never cleared", [ended.archived ?? false, ended.until, showingLinks((await storeForEmail(OWNER))!.links).some((l) => l.id === other.id)], [false, "2021-01-01T00:00:00.000Z", false]);
  is("twice the same is the same", [(await post({ action: "archive", id: link.id })).status, (await post({ action: "archive", id: link.id })).status, (await storeForEmail(OWNER))!.links.filter((l) => l.archived).length], [200, 200, 1]);
  await post({ action: "add", title: "Listen", url: "", header: true });
  const head = (await storeForEmail(OWNER))!.links[2];
  is("a heading can be archived too", [(await post({ action: "archive", id: head.id })).status, (await storeForEmail(OWNER))!.links[2].archived], [200, true]);
  is("a link that is not there", [(await post({ action: "archive", id: "nope" })).status, (await post({ action: "unarchive", id: "" })).status], [404, 400]);

  part("In the studio");
  is(
    "after, it says where the link now stands",
    [
      archiveDoneWords({}, true),
      archiveDoneWords({ header: true }, true),
      archiveDoneWords({}, false),
      archiveDoneWords({ until: "2021-01-01T00:00:00.000Z" }, false),
      archiveDoneWords({ from: "2099-01-01T00:00:00.000Z" }, false),
    ],
    [
      "Link archived. It is hidden from your page and kept here; press Show again to bring it back.",
      "Heading archived. It is hidden from your page and kept here; press Show again to bring it back.",
      "Link shown on your page again.",
      "Link no longer archived, but its end time has passed, so it stays hidden. Edit its times to show it.",
      "Link no longer archived. It shows on your page from its start time.",
    ],
  );
  const editor = readFileSync("components/link-editor.tsx", "utf8").replace(/\s+/g, " ");
  is(
    "one press each way, named with the link, the state said in words beside it",
    [
      editor.includes('{ action: link.archived ? "unarchive" : "archive", id: link.id }'),
      editor.includes('aria-label={`${link.archived ? "Show again" : "Archive"}: ${link.title}`}'),
      editor.includes('{link.archived ? "Show again" : "Archive"}'),
      editor.includes('"Archived, hidden from your page; its times are kept" : "Archived, hidden from your page"'),
    ],
    [true, true, true, true],
  );
  is("the store page reads its links only through showingLinks", readFileSync("app/[handle]/page.tsx", "utf8").includes("const links = showingLinks(store.links);"), true);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
