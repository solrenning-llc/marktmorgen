/**
 * 33 [F2], part 1: the public podcast feed, as a pure rule (lib/podcast-public-feed.ts).
 *
 * What is checked:
 *   - the private per-buyer feed (lib/podcast-rules.ts, feedXml) stays byte for byte what it is today;
 *   - the public feed carries no itunes:block, and does carry the category, language, image, explicit flag and an
 *     enclosure with the episode's exact size;
 *   - only an episode the creator marked exactly "public" appears: paid, private and unknown marks never do (rule 24);
 *   - no buyer data reaches it: an audio address with a buyer's feed token or an email is refused, not published;
 *   - text is escaped, and what it writes reads back exactly through the import parser (lib/rss-import.ts).
 *
 * Synthetic data only; nothing here makes a request.
 */
import { feedXml, MAX_EPISODES, type Episode } from "@/lib/podcast-rules";
import { PUBLIC_CATEGORIES, PublicFeedError, publicEpisodes, publicFeedXml, type PublicFeedInput } from "@/lib/podcast-public-feed";
import { parseRssImport } from "@/lib/rss-import";
import { done, is, part } from "./check";

let fetched = 0;
globalThis.fetch = (async () => {
  fetched += 1;
  throw new Error("no request may be made here");
}) as typeof fetch;

const TOKEN = "f".repeat(48);

function episode(id: string, title: string, at: number, extra: Partial<Episode> = {}): Episode {
  return { id, title, notes: `Notes for ${title}`, pathname: `stores/harbor/${id}.mp3`, bytes: 1000, contentType: "audio/mpeg", at, ...extra };
}

function refusal(run: () => unknown): string | null {
  try {
    run();
    return null;
  } catch (error) {
    return error instanceof PublicFeedError ? error.reason : `other: ${String(error)}`;
  }
}

function main(): void {
  part("The private per-buyer feed stays byte for byte the same");
  const privateEpisodes: Episode[] = [
    { id: "ep0000000001", title: 'Starter <basics> & "more"', notes: "Line one\nTab\there \u0001ctl", pathname: "p/a.mp3", bytes: 1000, contentType: "audio/mpeg", at: 1_790_000_000 },
    { id: "ep0000000002", title: "Shaping", notes: "", pathname: "p/b.m4a", bytes: 2048, contentType: "audio/mp4", at: 1_790_100_000 },
  ];
  const privateXml = feedXml({
    title: "Sourdough & Co",
    summary: "",
    author: "Harbor <Kitchen>",
    page: "https://marktmorgen.com/harbor/podcast/x",
    image: "https://marktmorgen.com/i.png?a=1&b=2",
    episodes: privateEpisodes,
    audio: (e) => `https://marktmorgen.com/api/store/podcast/play/${TOKEN}/${e.id}`,
    language: "es-es",
  });
  // Captured from origin/main 0e8b8c6b53 before this unit; any change to the private feed fails here.
  is(
    "identical to the feed written before this unit",
    privateXml,
    "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<rss version=\"2.0\" xmlns:itunes=\"http://www.itunes.com/dtds/podcast-1.0.dtd\">\n  <channel>\n    <title>Sourdough &amp; Co</title>\n    <link>https://marktmorgen.com/harbor/podcast/x</link>\n    <description>Sourdough &amp; Co</description>\n    <language>es-es</language>\n    <itunes:author>Harbor &lt;Kitchen&gt;</itunes:author>\n    <itunes:block>Yes</itunes:block>\n    <itunes:explicit>false</itunes:explicit>\n    <itunes:image href=\"https://marktmorgen.com/i.png?a=1&amp;b=2\"/>\n    <item>\n      <title>Shaping</title>\n      <description></description>\n      <guid isPermaLink=\"false\">ep0000000002</guid>\n      <pubDate>Tue, 22 Sep 2026 18:00:00 GMT</pubDate>\n      <enclosure url=\"https://marktmorgen.com/api/store/podcast/play/ffffffffffffffffffffffffffffffffffffffffffffffff/ep0000000002\" length=\"2048\" type=\"audio/mp4\"/>\n    </item>\n    <item>\n      <title>Starter &lt;basics&gt; &amp; &quot;more&quot;</title>\n      <description>Line one\nTab\there ctl</description>\n      <guid isPermaLink=\"false\">ep0000000001</guid>\n      <pubDate>Mon, 21 Sep 2026 14:13:20 GMT</pubDate>\n      <enclosure url=\"https://marktmorgen.com/api/store/podcast/play/ffffffffffffffffffffffffffffffffffffffffffffffff/ep0000000001\" length=\"1000\" type=\"audio/mpeg\"/>\n    </item>\n  </channel>\n</rss>\n",
  );
  is("the private feed still keeps out of directories", privateXml.includes("<itunes:block>Yes</itunes:block>"), true);

  part("Only an episode marked exactly public appears");
  const open = episode("pub000000001", "Open episode", 1_790_000_000);
  const newer = episode("pub000000002", "Newer open episode", 1_790_500_000, { bytes: 4_321_987, contentType: "audio/mp4" });
  const paid = episode("paid00000001", "Paid episode", 1_790_100_000);
  const kept = episode("priv00000001", "Private episode", 1_790_200_000);
  const unknowns = [undefined, null, true, "PUBLIC", "public ", 1, {}, "yes"].map((visibility, n) => ({
    episode: episode(`unk00000000${n}`, `Unknown mark ${n}`, 1_790_300_000 + n),
    visibility,
  }));
  const candidates = [
    { episode: open, visibility: "public" },
    { episode: paid, visibility: "paid" },
    { episode: kept, visibility: "private" },
    { episode: newer, visibility: "public" },
    ...unknowns,
  ];
  const chosen = publicEpisodes(candidates);
  is("the public ones, newest first", chosen.episodes.map((e) => e.id), ["pub000000002", "pub000000001"]);
  is(
    "each left-out episode says why",
    chosen.left.map((l) => [l.id, l.reason]),
    [
      ["paid00000001", "not-public"],
      ["priv00000001", "not-public"],
      ...unknowns.map((u) => [u.episode.id, "not-public"]),
    ],
  );
  const sizeUnknown = [
    { episode: episode("size00000001", "No size", 1, { bytes: 0 }), visibility: "public" },
    { episode: episode("size00000002", "Half a byte", 2, { bytes: 1.5 }), visibility: "public" },
    { episode: episode("size00000003", "Not a number", 3, { bytes: Number.NaN }), visibility: "public" },
    { episode: episode("type00000001", "Odd type", 4, { contentType: "audio/ogg" }), visibility: "public" },
    { episode: episode("date00000001", "No date", 0), visibility: "public" },
    { episode: episode("titl00000001", "   ", 5), visibility: "public" },
    { episode: episode("BAD-ID", "Bad id", 6), visibility: "public" },
  ];
  is(
    "a public mark with an unknown size, type, date, title or id is left out, never published as zero",
    publicEpisodes(sizeUnknown).left.map((l) => l.reason),
    ["size-unknown", "size-unknown", "size-unknown", "type-unknown", "date-unknown", "no-title", "bad-id"],
  );
  is("and none of them is chosen", publicEpisodes(sizeUnknown).episodes.length, 0);
  is(
    "a date past what RFC 822 can write (year 10000 or beyond Date's range) is unknown, never written",
    publicEpisodes([
      { episode: episode("far000000001", "Year 10000", 253_402_300_800), visibility: "public" },
      { episode: episode("far000000002", "Beyond Date", 9_000_000_000_000), visibility: "public" },
    ]).left.map((l) => l.reason),
    ["date-unknown", "date-unknown"],
  );


  part("The public feed");
  const input: PublicFeedInput = {
    title: "Sourdough Radio & Friends",
    summary: "Bread, <slowly>.",
    author: "Harbor Kitchen",
    page: "https://marktmorgen.com/harbor/podcast/radio",
    image: "https://marktmorgen.com/media/harbor/cover.jpg",
    category: "Arts",
    explicit: false,
    language: "en-us",
    episodes: candidates,
    audio: (e) => `https://media.marktmorgen.com/public/harbor/${e.id}.mp3`,
  };
  const xml = publicFeedXml(input);
  is("no itunes:block", xml.includes("itunes:block"), false);
  is("the category", xml.includes('<itunes:category text="Arts"/>'), true);
  is("the language", xml.includes("<language>en-us</language>"), true);
  is("the image", xml.includes('<itunes:image href="https://marktmorgen.com/media/harbor/cover.jpg"/>'), true);
  is("explicit, as written", xml.includes("<itunes:explicit>false</itunes:explicit>"), true);
  is(
    "an enclosure with the exact size and type",
    xml.includes('<enclosure url="https://media.marktmorgen.com/public/harbor/pub000000002.mp3" length="4321987" type="audio/mp4"/>'),
    true,
  );
  is("the public episodes are in it", ["Open episode", "Newer open episode"].every((t) => xml.includes(t)), true);
  is("no paid episode", xml.includes("Paid episode") || xml.includes("paid00000001"), false);
  is("no private episode", xml.includes("Private episode") || xml.includes("priv00000001"), false);
  is("no episode with an unknown mark", xml.includes("Unknown mark"), false);
  is("no buyer token", /[0-9a-f]{48}/i.test(xml), false);
  is("no address of anybody", xml.includes("@"), false);
  is("escaped", xml.includes("<title>Sourdough Radio &amp; Friends</title>") && xml.includes("Bread, &lt;slowly&gt;."), true);
  is("explicit true is written when the creator says so", publicFeedXml({ ...input, explicit: true }).includes("<itunes:explicit>true</itunes:explicit>"), true);
  const empty = publicFeedXml({ ...input, episodes: [{ episode: paid, visibility: "paid" }] });
  is("no public episode: a feed with no items, not the paid one", [empty.includes("<item>"), empty.includes("Paid episode")], [false, false]);

  part("What it writes reads back exactly");
  const tricky = episode("trik00000001", `Q&A: "rye" <vs> 'spelt' — café ✓ 𝄞`, 1_790_600_000, { notes: "Two lines\nand a tab\there; a control \u0001 char." });
  const back = parseRssImport(publicFeedXml({ ...input, episodes: [{ episode: tricky, visibility: "public" }] }));
  is("the import parser accepts it", back.ok, true);
  if (back.ok) {
    is("title round trip", back.show.title, input.title);
    is("episode title round trip, every character", back.show.episodes[0]?.title, tricky.title);
    is("notes round trip, the control character dropped as XML requires", back.show.episodes[0]?.notes, "Two lines\nand a tab\there; a control  char.");
    is("size round trip", back.show.episodes[0]?.bytes, 1000);
    is("date round trip", back.show.episodes[0]?.at, 1_790_600_000);
  }

  part("Every date is written as RFC 822");
  const last = episode("last00000001", "Last second of 9999", 253_402_300_799);
  const lastXml = publicFeedXml({ ...input, episodes: [{ episode: last, visibility: "public" }] });
  is("the last second RFC 822 can write", lastXml.includes("<pubDate>Fri, 31 Dec 9999 23:59:59 GMT</pubDate>"), true);
  const far = publicFeedXml({ ...input, episodes: [{ episode: episode("far000000002", "Beyond Date", 9_000_000_000_000), visibility: "public" }] });
  is("an episode with a date past that is left out, never Invalid Date", [far.includes("Invalid Date"), far.includes("<item>")], [false, false]);
  const dates = [...xml.matchAll(/<pubDate>([^<]*)<\/pubDate>/g)].map((m) => m[1]);
  is(
    "each pubDate in the feed is an RFC 822 date",
    dates.length > 0 && dates.every((d) => /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), [0-3][0-9] (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) [0-9]{4} [0-2][0-9]:[0-5][0-9]:[0-5][0-9] GMT$/.test(d)),
    true,
  );

  part("No buyer data and nothing unknown is published");
  is("an audio address with a buyer's feed token is refused", refusal(() => publicFeedXml({ ...input, audio: (e) => `https://marktmorgen.com/api/store/podcast/play/${TOKEN}/${e.id}` })), "buyer-data");
  is("an audio address with an email is refused", refusal(() => publicFeedXml({ ...input, audio: (e) => `https://x.example/${e.id}?to=dana@example.com` })), "buyer-data");
  is("a store page is /@handle, and is published", refusal(() => publicFeedXml({ ...input, page: "https://marktmorgen.com/@harbor/podcast/radio" })), null);
  is("an audio address under /@handle is published", refusal(() => publicFeedXml({ ...input, audio: (e) => `https://marktmorgen.com/@harbor/podcast/${e.id}.mp3` })), null);
  is("an address with a user before the host is refused", refusal(() => publicFeedXml({ ...input, page: "https://dana@marktmorgen.com/@harbor" })), "not-https");
  is("an email in the query is refused, even under /@handle", refusal(() => publicFeedXml({ ...input, page: "https://marktmorgen.com/@harbor?email=dana@example.com" })), "buyer-data");
  is("an escaped email in the query is refused", refusal(() => publicFeedXml({ ...input, page: "https://marktmorgen.com/@harbor?email=dana%40example.com" })), "buyer-data");
  is("an email in the path is refused", refusal(() => publicFeedXml({ ...input, audio: (e) => `https://x.example/dana@example.com/${e.id}.mp3` })), "buyer-data");
  is("an escaped buyer token is refused", refusal(() => publicFeedXml({ ...input, audio: (e) => `https://x.example/${"%66".repeat(48)}/${e.id}.mp3` })), "buyer-data");
  is("an audio address that is not https is refused", refusal(() => publicFeedXml({ ...input, audio: (e) => `http://media.example/${e.id}.mp3` })), "not-https");
  is("a page that is not https is refused", refusal(() => publicFeedXml({ ...input, page: "javascript:alert(1)" })), "not-https");
  is("an image that is not https is refused", refusal(() => publicFeedXml({ ...input, image: "http://x.example/a.jpg" })), "not-https");
  is("no image is allowed", refusal(() => publicFeedXml({ ...input, image: null })), null);
  is("an unknown category is refused", refusal(() => publicFeedXml({ ...input, category: "Cooking" as never })), "category");
  is("an explicit flag that is not true or false is refused", refusal(() => publicFeedXml({ ...input, explicit: "no" as never })), "explicit");
  is("an unknown language is refused", refusal(() => publicFeedXml({ ...input, language: "english" })), "language");
  is("an empty show title is refused", refusal(() => publicFeedXml({ ...input, title: "  " })), "title");
  const many = Array.from({ length: MAX_EPISODES + 1 }, (_, n) => ({ episode: episode(`m${String(n).padStart(11, "0")}`, `E${n}`, n + 1), visibility: "public" }));
  is("more episodes than a podcast holds is refused, not cut", refusal(() => publicFeedXml({ ...input, episodes: many })), "too-many-episodes");
  is("the categories are Apple's top-level ones", PUBLIC_CATEGORIES.includes("Arts") && PUBLIC_CATEGORIES.includes("True Crime"), true);
  is("no request was made", fetched, 0);
}

main();
done();
