/**
 * 33 [F2], part 1: importing an existing podcast's RSS, as a pure parser (lib/rss-import.ts).
 *
 * What is checked:
 *   - a healthy feed gives the show and each episode exactly (CDATA, entities, dates, sizes, https audio);
 *   - hard caps on bytes, episodes and every field's length: over a cap the whole feed is refused, never cut;
 *   - no DTD and no entity expansion: XXE, billion laughs and undeclared entities are refused;
 *   - a malformed feed is refused with a reason and no show at all, never half imported;
 *   - an episode's audio is an https address, recorded and never fetched here.
 *
 * Synthetic feeds only; nothing here makes a request.
 */
import {
  MAX_IMPORT_BYTES,
  MAX_IMPORT_ITEMS,
  MAX_IMPORT_NOTES,
  MAX_IMPORT_TITLE,
  MAX_IMPORT_URL,
  MAX_XML_DEPTH,
  parseRssImport,
  type RssImportResult,
} from "@/lib/rss-import";
import { MAX_EPISODES, MAX_EPISODE_NOTES, MAX_EPISODE_TITLE } from "@/lib/podcast-rules";
import { done, is, part } from "./check";

let fetched = 0;
globalThis.fetch = (async () => {
  fetched += 1;
  throw new Error("no request may be made here");
}) as typeof fetch;

type Item = { title?: string; description?: string; enclosure?: string | null; pubDate?: string; guid?: string; raw?: string };

function item(n: number, over: Item = {}): string {
  if (over.raw !== undefined) return over.raw;
  const enclosure =
    over.enclosure === null
      ? ""
      : over.enclosure ?? `<enclosure url="https://cdn.example.com/show/ep${n}.mp3" length="${1000 + n}" type="audio/mpeg"/>`;
  return `<item>
  <title>${over.title ?? `Episode ${n}`}</title>
  <description>${over.description ?? `Notes ${n}`}</description>
  ${enclosure}
  <pubDate>${over.pubDate ?? "Mon, 21 Sep 2026 14:13:20 GMT"}</pubDate>
  <guid isPermaLink="false">${over.guid ?? `guid-${n}`}</guid>
</item>`;
}

function feed(items: string[], channelExtra = "", prolog = '<?xml version="1.0" encoding="UTF-8"?>\n'): string {
  return `${prolog}<rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd">
<channel>
  <title>Rye &amp; Shine</title>
  <description><![CDATA[A show about <b>bread</b> & rye.]]></description>
  <language>en-us</language>
  <itunes:author>Old Host</itunes:author>
  <itunes:image href="https://cdn.example.com/show/cover.jpg"/>
  ${channelExtra}
  ${items.join("\n")}
</channel>
</rss>`;
}

function reason(result: RssImportResult): string {
  return result.ok ? "ok" : result.reason;
}

function refusedWhole(result: RssImportResult): boolean {
  return !result.ok && !("show" in result) && typeof result.detail === "string" && result.detail.length > 0;
}

function main(): void {
  part("A healthy feed");
  const good = parseRssImport(
    feed([
      item(1, { title: "Caf&#233; &#x2019;starter&#x2019; &lt;one&gt;", description: "<![CDATA[<p>Hello & welcome</p>]]>" }),
      item(2, { enclosure: '<enclosure url="https://cdn.example.com/show/ep2.m4a" length="0" type="audio/x-m4a"/>', pubDate: "" }),
      item(3, { enclosure: '<enclosure url="https://cdn.example.com/show/ep3.mp3"/>' }),
    ]),
  );
  is("accepted", good.ok, true);
  if (good.ok) {
    is("the show title, entities decoded", good.show.title, "Rye & Shine");
    is("the show description, CDATA kept as written", good.show.description, "A show about <b>bread</b> & rye.");
    is("language", good.show.language, "en-us");
    is("author", good.show.author, "Old Host");
    is("image, https", good.show.image, "https://cdn.example.com/show/cover.jpg");
    is("three episodes, in feed order", good.show.episodes.length, 3);
    const [one, two, three] = good.show.episodes;
    is("numeric entities decoded exactly", one.title, "Café ’starter’ <one>");
    is("notes from CDATA, recorded as text", one.notes, "<p>Hello & welcome</p>");
    is("markup in notes is flagged for the preview, not stripped", [one.notesHaveMarkup, three.notesHaveMarkup], [true, false]);
    is("audio address recorded", one.audioUrl, "https://cdn.example.com/show/ep1.mp3");
    is("size recorded exactly", one.bytes, 1001);
    is("type recorded", one.contentType, "audio/mpeg");
    is("date in seconds", one.at, 1_790_000_000);
    is("guid", one.guid, "guid-1");
    is("a size of 0 is unknown, never zero bytes", two.bytes, null);
    is("an m4a type is the m4a the podcast keeps", two.contentType, "audio/mp4");
    is("an empty date is unknown, never the epoch", two.at, null);
    is("no length and no type: both unknown", [three.bytes, three.contentType], [null, null]);
  }
  is("the caps are the podcast's own", [MAX_IMPORT_ITEMS, MAX_IMPORT_TITLE, MAX_IMPORT_NOTES], [MAX_EPISODES, MAX_EPISODE_TITLE, MAX_EPISODE_NOTES]);
  is("a byte array in UTF-8 reads the same", reason(parseRssImport(new TextEncoder().encode(feed([item(1)])))), "ok");
  is("a byte order mark is fine", reason(parseRssImport("﻿" + feed([item(1)]))), "ok");
  is("a comment and a stylesheet line are fine", reason(parseRssImport(feed([item(1)], "<!-- hi -->", '<?xml version="1.0"?>\n<?xml-stylesheet type="text/xsl" href="s.xsl"?>\n'))), "ok");
  is("a feed with no episodes is refused: nothing to import", reason(parseRssImport(feed([]))), "empty");

  part("Hard caps: over one, the whole feed is refused");
  const big = feed([item(1)], " ".repeat(MAX_IMPORT_BYTES));
  is("over the byte cap, as text", reason(parseRssImport(big)), "too-large");
  is("over the byte cap, as bytes, before decoding", reason(parseRssImport(new Uint8Array(MAX_IMPORT_BYTES + 1))), "too-large");
  const multibyte = "é".repeat(Math.floor(MAX_IMPORT_BYTES / 2) + 1);
  is("the cap counts bytes, not characters", reason(parseRssImport(multibyte)), "too-large");
  const most = Array.from({ length: MAX_IMPORT_ITEMS }, (_, n) => item(n));
  is("exactly the episode cap is accepted", reason(parseRssImport(feed(most))), "ok");
  is("one over the episode cap is refused, not cut", reason(parseRssImport(feed([...most, item(999)]))), "too-many-episodes");
  is("a title one over its cap", reason(parseRssImport(feed([item(1, { title: "t".repeat(MAX_IMPORT_TITLE + 1) })]))), "field-too-long");
  is("a title at its cap", reason(parseRssImport(feed([item(1, { title: "t".repeat(MAX_IMPORT_TITLE) })]))), "ok");
  is("notes one over their cap", reason(parseRssImport(feed([item(1, { description: "n".repeat(MAX_IMPORT_NOTES + 1) })]))), "field-too-long");
  const longUrl = `https://cdn.example.com/${"a".repeat(MAX_IMPORT_URL)}.mp3`;
  is("an audio address over its cap", reason(parseRssImport(feed([item(1, { enclosure: `<enclosure url="${longUrl}" type="audio/mpeg"/>` })]))), "field-too-long");
  is("a guid over its cap", reason(parseRssImport(feed([item(1, { guid: "g".repeat(600) })]))), "field-too-long");
  is("a show title over its cap", reason(parseRssImport(feed([item(1)]).replace("Rye &amp; Shine", "s".repeat(300)))), "field-too-long");
  const deep = "<x>".repeat(MAX_XML_DEPTH + 5) + "</x>".repeat(MAX_XML_DEPTH + 5);
  is("nesting deeper than the cap", reason(parseRssImport(feed([item(1)], deep))), "too-deep");

  part("No DTD and no entity expansion");
  const laughs = `<?xml version="1.0"?>
<!DOCTYPE lolz [
 <!ENTITY lol "lol">
 <!ENTITY lol2 "&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;">
 <!ENTITY lol3 "&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;">
]>
<rss version="2.0"><channel><title>&lol3;</title>${item(1)}</channel></rss>`;
  is("billion laughs", reason(parseRssImport(laughs)), "doctype");
  const xxe = `<?xml version="1.0"?>
<!DOCTYPE rss [<!ENTITY xxe SYSTEM "file:///etc/passwd">]>
<rss version="2.0"><channel><title>&xxe;</title>${item(1)}</channel></rss>`;
  is("an external entity (XXE)", reason(parseRssImport(xxe)), "doctype");
  is("a doctype in lower case", reason(parseRssImport(feed([item(1)], "", '<?xml version="1.0"?>\n<!doctype rss>\n'))), "doctype");
  is("an entity declaration without a doctype", reason(parseRssImport(feed([item(1)], '<!ENTITY a "b">'))), "doctype");
  is("an undeclared named entity", reason(parseRssImport(feed([item(1, { title: "Caf&eacute;" })]))), "entity");
  is("an entity in an attribute", reason(parseRssImport(feed([item(1, { enclosure: '<enclosure url="https://cdn.example.com/&ext;.mp3" type="audio/mpeg"/>' })]))), "entity");
  is("a character reference to a forbidden character", reason(parseRssImport(feed([item(1, { title: "a&#0;b" })]))), "malformed");
  is("a character reference to a lone surrogate", reason(parseRssImport(feed([item(1, { title: "a&#xD800;b" })]))), "malformed");
  is("the word DOCTYPE inside CDATA is only text", reason(parseRssImport(feed([item(1, { description: "<![CDATA[write <!DOCTYPE html> first]]>" })]))), "ok");

  part("Malformed: refused with a reason, never half imported");
  const halves: [string, string][] = [
    ["an unclosed tag", feed([item(1)]).replace("</channel>", "")],
    ["a mismatched end tag", feed([item(1, { title: "<b>x</i>" })])],
    ["a bare ampersand", feed([item(1, { title: "Salt & pepper" })])],
    ["a second root", feed([item(1)]) + "<rss></rss>"],
    ["text after the root", feed([item(1)]) + "trailing"],
    ["an unclosed comment", feed([item(1)], "<!-- never closed")],
    ["an unclosed CDATA", feed([item(1, { description: "<![CDATA[open" })])],
    ["a duplicate attribute", feed([item(1, { enclosure: '<enclosure url="https://a.example/1.mp3" url="https://a.example/2.mp3"/>' })])],
    ["an attribute without quotes", feed([item(1, { enclosure: "<enclosure url=https://a.example/1.mp3/>" })])],
    ["a less-than sign in an attribute", feed([item(1, { enclosure: '<enclosure url="https://a.example/<1>.mp3"/>' })])],
    ["markup inside a title", feed([item(1, { title: "A <b>bold</b> title" })])],
    ["a good episode then a bad one", feed([item(1), item(2, { enclosure: '<enclosure url="http://cdn.example.com/ep2.mp3" type="audio/mpeg"/>' })])],
  ];
  for (const [what, text] of halves) {
    const result = parseRssImport(text);
    is(`${what}: refused, with a reason and no show`, [result.ok, refusedWhole(result)], [false, true]);
  }
  is("a mismatched end tag is malformed", reason(parseRssImport(halves[1][1])), "malformed");
  is("an empty document", reason(parseRssImport("")), "malformed");
  is("not a string or bytes", reason(parseRssImport(42 as never)), "malformed");
  is("an Atom feed is not RSS", reason(parseRssImport('<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><title>x</title></feed>')), "not-rss");
  is("RSS with no channel", reason(parseRssImport('<rss version="2.0"></rss>')), "not-rss");
  is("RSS with two channels", reason(parseRssImport(`<rss version="2.0"><channel><title>a</title>${item(1)}</channel><channel><title>b</title></channel></rss>`)), "not-rss");
  is("a show with no title", reason(parseRssImport(feed([item(1)]).replace("<title>Rye &amp; Shine</title>", ""))), "no-title");
  is("an episode with no title", reason(parseRssImport(feed([item(1, { title: "   " })]))), "no-title");
  is("bytes that are not UTF-8", reason(parseRssImport(new Uint8Array([0x3c, 0x72, 0x73, 0x73, 0xff, 0xfe, 0x3e]))), "not-utf8");
  is("a declared encoding other than UTF-8", reason(parseRssImport(feed([item(1)], "", '<?xml version="1.0" encoding="ISO-8859-1"?>\n'))), "not-utf8");
  is("a date that cannot be read", reason(parseRssImport(feed([item(1, { pubDate: "sometime in spring" })]))), "bad-date");
  part("Dates: RFC 822 only, as RSS requires; anything else is unknown, never guessed (rule 24)");
  const dateOf = (pubDate: string) => {
    const r = parseRssImport(feed([item(1, { pubDate })]));
    return r.ok ? r.show.episodes[0]?.at : r.reason;
  };
  const nov9 = Date.UTC(2026, 10, 9, 10, 0, 0) / 1000;
  for (const bad of [
    "Episode 12",
    "hello 1",
    "TBD 5",
    "5",
    "Mon, 09 Nov 2026 10:00:00",
    "2026-11-09T10:00",
    "2026-11-09T10:00:00Z",
    "11/09/2026",
    "31 Feb 2026 10:00:00 GMT",
    "Tue, 09 Nov 2026 10:00:00 GMT",
    "09 Nov 26 10:00:00 GMT",
    "09 Nov 2026 24:00:00 GMT",
    "09 Nov 2026 10:60:00 GMT",
    "09 Nov 2026 10:00:00 +2400",
    "09 Nov 2026 10:00:00 A",
    "09 Nov 2026 10:00:00 CET",
    "09 November 2026 10:00:00 GMT",
    "Mon, 09 Nov 2026 10:00:00 GMT trailing",
  ]) {
    is(`"${bad}" is refused as a date that cannot be read`, dateOf(bad), "bad-date");
  }
  const badDate = parseRssImport(feed([item(1, { pubDate: "11/09/2026" })]));
  is("the refusal says which episode and what a readable date looks like", badDate.ok ? "ok" : /Episode 1.*Mon, 09 Nov 2026 10:00:00 GMT/.test(badDate.detail), true);
  is("RFC 822 with GMT", dateOf("Mon, 09 Nov 2026 10:00:00 GMT"), nov9);
  is("no weekday, one-digit day, no seconds", dateOf("9 Nov 2026 10:00 GMT"), nov9);
  is("UT and Z mean GMT", [dateOf("09 Nov 2026 10:00:00 UT"), dateOf("09 Nov 2026 10:00:00 Z")], [nov9, nov9]);
  is("a numeric offset is applied, never the server's time zone", [dateOf("Mon, 09 Nov 2026 07:00:00 -0300"), dateOf("Mon, 09 Nov 2026 11:30:00 +0130")], [nov9, nov9]);
  is("US zone names", [dateOf("Mon, 09 Nov 2026 05:00:00 EST"), dateOf("Mon, 09 Nov 2026 03:00:00 PDT")], [nov9, nov9]);
  is("names in any letter case", dateOf("mon, 09 nov 2026 10:00:00 gmt"), nov9);
  is("a leap-year day", dateOf("Tue, 29 Feb 2028 00:00:00 GMT"), Date.UTC(2028, 1, 29) / 1000);
  is("29 Feb in a common year is refused", dateOf("29 Feb 2027 00:00:00 GMT"), "bad-date");

  is("a size that is not a whole number", reason(parseRssImport(feed([item(1, { enclosure: '<enclosure url="https://a.example/1.mp3" length="12x" type="audio/mpeg"/>' })]))), "bad-length");
  is("a negative size", reason(parseRssImport(feed([item(1, { enclosure: '<enclosure url="https://a.example/1.mp3" length="-5" type="audio/mpeg"/>' })]))), "bad-length");

  part("Audio: an https address, recorded, never fetched");
  const audio = (enclosure: string | null) => reason(parseRssImport(feed([item(1, { enclosure })])));
  is("http", audio('<enclosure url="http://cdn.example.com/1.mp3" type="audio/mpeg"/>'), "audio-not-https");
  is("javascript:", audio('<enclosure url="javascript:alert(1)" type="audio/mpeg"/>'), "audio-not-https");
  is("file:", audio('<enclosure url="file:///etc/passwd" type="audio/mpeg"/>'), "audio-not-https");
  is("credentials in the address", audio('<enclosure url="https://user:pw@cdn.example.com/1.mp3" type="audio/mpeg"/>'), "audio-not-https");
  is("localhost", audio('<enclosure url="https://localhost/1.mp3" type="audio/mpeg"/>'), "audio-not-https");
  is("localhost with a trailing dot", audio('<enclosure url="https://localhost./1.mp3" type="audio/mpeg"/>'), "audio-not-https");
  is("a .localhost name with a trailing dot", audio('<enclosure url="https://foo.localhost./1.mp3" type="audio/mpeg"/>'), "audio-not-https");
  is("an ordinary name with a trailing dot is still a public name", audio('<enclosure url="https://cdn.example.com./1.mp3" type="audio/mpeg"/>'), "ok");
  is("an IP address", audio('<enclosure url="https://169.254.169.254/latest/meta-data" type="audio/mpeg"/>'), "audio-not-https");
  is("an IPv6 address", audio('<enclosure url="https://[::1]/1.mp3" type="audio/mpeg"/>'), "audio-not-https");
  is("not an address", audio('<enclosure url="not a url" type="audio/mpeg"/>'), "audio-not-https");
  is("no enclosure", audio(null), "audio-missing");
  is("an enclosure with no address", audio('<enclosure type="audio/mpeg"/>'), "audio-missing");
  is("video is not an episode the podcast keeps", audio('<enclosure url="https://cdn.example.com/1.mp4" type="video/mp4"/>'), "audio-type");
  is("two enclosures in one episode", audio('<enclosure url="https://a.example/1.mp3"/><enclosure url="https://a.example/2.mp3"/>'), "malformed");
  is("a show image that is not https is left out and flagged, the audio rules unchanged", (() => {
    const r = parseRssImport(feed([item(1)]).replace("https://cdn.example.com/show/cover.jpg", "http://cdn.example.com/show/cover.jpg"));
    return r.ok ? [r.show.image, r.show.imageRefused] : r.reason;
  })(), [null, true]);
  part("Notes with many unclosed tags are read in linear time");
  const open = "<a".repeat(1999);
  const flagged = parseRssImport(feed([item(1, { description: `<![CDATA[${open}]]>` }), item(2, { description: "<![CDATA[a <b>bold</b> word]]>" })]));
  is("unclosed tags are not markup, a closed one is", flagged.ok ? flagged.show.episodes.map((e) => e.notesHaveMarkup) : flagged.reason, [false, true]);
  const slow = feed(Array.from({ length: 300 }, (_, n) => item(n + 1, { description: `<![CDATA[${open}]]>` })));
  const started = performance.now();
  const many = parseRssImport(slow);
  const took = performance.now() - started;
  is("300 such episodes parse well under 400 ms", [many.ok, took < 400], [true, true]);
  is("no request was made by any of it", fetched, 0);
}

main();
done();
