/**
 * A podcast feed only ever holds characters XML 1.0 allows (Claude 7, 13 November 2026).
 *
 * feedXml's escaping took out control characters but kept U+FFFE, U+FFFF and unpaired surrogates, none of which
 * XML 1.0 allows (Char production, section 2.2). An episode title cut at its limit in the middle of an emoji
 * (lib/community-text.ts cleanText slices by UTF-16 unit) leaves an unpaired surrogate, and a strict podcast app then
 * refuses the whole feed, every episode with it.
 */
import { done, is, part } from "./check";
import { editPodcast } from "@/lib/podcast";
import { MAX_EPISODE_TITLE, feedXml, type Episode } from "@/lib/podcast-rules";

/** Every character outside XML 1.0's Char production, as code points. */
function outsideXml(text: string): number[] {
  const bad: number[] = [];
  for (let i = 0; i < text.length; i += 1) {
    const unit = text.charCodeAt(i);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        i += 1;
        continue;
      }
      bad.push(unit);
    } else if (unit >= 0xdc00 && unit <= 0xdfff) bad.push(unit);
    else if (unit === 0xfffe || unit === 0xffff) bad.push(unit);
    else if (unit < 0x20 && unit !== 0x9 && unit !== 0xa && unit !== 0xd) bad.push(unit);
  }
  return bad;
}

const episode = (title: string, notes = ""): Episode => ({ id: "abcdefabcdef", title, notes, pathname: "stores/f/p/a.mp3", bytes: 10, contentType: "audio/mpeg", at: 1_800_000_000 });
const feed = (episodes: Episode[], title = "Show") =>
  feedXml({ title, summary: "", author: "Store", page: "https://marktmorgen.com/@s/p/x", image: null, episodes, audio: (e) => `https://marktmorgen.com/a/${e.id}.mp3` });

part("Control: an ordinary title with an emoji is kept whole");
is("nothing outside XML 1.0", outsideXml(feed([episode("Episode one \u{1F399}")])), []);
is("and the emoji is there", feed([episode("Episode one \u{1F399}")]).includes("\u{1F399}"), true);

part("A title cut in the middle of an emoji still makes a well-formed feed");
const cut = editPodcast({ id: "0".repeat(32), episodes: [] }, { op: "add", pathname: "stores/f/p/a.mp3", bytes: 10, contentType: "audio/mpeg", title: `${"a".repeat(MAX_EPISODE_TITLE - 1)}\u{1F399}`, notes: "", at: 1_800_000_000 });
is("the episode is added", cut.ok, true);
if (cut.ok) is("nothing outside XML 1.0", outsideXml(feed(cut.podcast.episodes)), []);

part("Noncharacters and unpaired surrogates never reach the feed");
for (const [what, text] of [["U+FFFE", "a￾b"], ["U+FFFF", "a￿b"], ["a lone high surrogate", "a\ud83cb"], ["a lone low surrogate", "a\udf99b"]] as const) {
  is(`${what} in a title`, outsideXml(feed([episode(text)])), []);
  is(`${what} in notes`, outsideXml(feed([episode("t", text)])), []);
  is(`${what} in the show's title`, outsideXml(feed([], text)), []);
}

done();
