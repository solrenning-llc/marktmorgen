/**
 * Importing an existing podcast's RSS feed, as a pure parser: text or bytes in, the show and its episodes out, or a
 * refusal with a reason. 33 [F2], part 1.
 *
 * Safe by construction, not by configuration:
 *   - hard caps before any work: bytes (MAX_IMPORT_BYTES), nesting, elements, attributes, episodes (the podcast's own
 *     MAX_EPISODES) and every field's length (the podcast's own title and notes caps);
 *   - no DTD at all: a DOCTYPE or any declaration (ENTITY, ELEMENT, ATTLIST, NOTATION) is refused, so external
 *     entities (XXE) and entity expansion (billion laughs) cannot happen; only XML's five predefined entities and
 *     character references are read, and any other named entity is refused;
 *   - all or nothing: one bad episode refuses the whole feed with a reason naming it, and a refusal carries no show,
 *     so nothing is ever half imported. Over a cap is refused too, never cut to fit;
 *   - an episode's audio is recorded as its https address only. Nothing here makes a request: copying the audio is
 *     a later unit, with its own address checks at fetch time, ceiling and cost line (MR).
 *
 * Unknown stays unknown (rule 24): a missing or zero size is null, never 0 bytes; a missing date is null, never the
 * epoch; a missing type is null. Something present and unreadable is refused.
 */
import { MAX_EPISODES, MAX_EPISODE_NOTES, MAX_EPISODE_TITLE } from "./podcast-rules";

export const MAX_IMPORT_BYTES = 5 * 1024 * 1024;
export const MAX_IMPORT_ITEMS = MAX_EPISODES;
export const MAX_IMPORT_TITLE = MAX_EPISODE_TITLE;
export const MAX_IMPORT_NOTES = MAX_EPISODE_NOTES;
export const MAX_IMPORT_URL = 2_048;
export const MAX_IMPORT_GUID = 512;
export const MAX_IMPORT_SHOW_TITLE = 255;
export const MAX_IMPORT_SHOW_DESCRIPTION = 4_000;
export const MAX_IMPORT_SHOW_AUTHOR = 255;
export const MAX_XML_DEPTH = 32;
export const MAX_XML_ELEMENTS = 50_000;
export const MAX_XML_ATTRIBUTES = 32;

export type ImportedEpisode = {
  title: string;
  /** As written in the feed; markup in it is kept and flagged, never stripped. */
  notes: string;
  notesHaveMarkup: boolean;
  /** https, recorded only: never fetched here. */
  audioUrl: string;
  /** Exact size from the feed, or null when the feed does not say (or says 0). */
  bytes: number | null;
  contentType: "audio/mpeg" | "audio/mp4" | null;
  /** Seconds, or null when the feed gives no date. */
  at: number | null;
  guid: string | null;
};

export type ImportedShow = {
  title: string;
  description: string;
  language: string | null;
  author: string | null;
  image: string | null;
  /** True when the feed named a cover that is not https: it is left out, and the preview says so. */
  imageRefused: boolean;
  episodes: ImportedEpisode[];
};

export type RssImportReason =
  | "too-large"
  | "not-utf8"
  | "malformed"
  | "doctype"
  | "entity"
  | "too-deep"
  | "too-many-elements"
  | "not-rss"
  | "empty"
  | "too-many-episodes"
  | "no-title"
  | "field-too-long"
  | "audio-missing"
  | "audio-not-https"
  | "audio-type"
  | "bad-length"
  | "bad-date";

export type RssImportResult = { ok: true; show: ImportedShow } | { ok: false; reason: RssImportReason; detail: string };

class Refusal extends Error {
  constructor(
    readonly reason: RssImportReason,
    readonly detail: string,
  ) {
    super(detail);
  }
}

function refuse(reason: RssImportReason, detail: string): never {
  throw new Refusal(reason, detail);
}

// ---------------------------------------------------------------------------------------------------------------
// A strict, small XML reader: elements, attributes, text, CDATA, comments and processing instructions. Nothing else.

type El = { name: string; attrs: Record<string, string>; kids: (El | string)[] };

const NOT_XML = /[^\t\n\r -퟿-�\u{10000}-\u{10FFFF}]/u;
const NAME = /[A-Za-z_][\w.:-]*/y;
const SPACE = /[ \t\r\n]*/y;
const ATTRIBUTE = /([A-Za-z_][\w.:-]*)[ \t\r\n]*=[ \t\r\n]*(?:"([^"<]*)"|'([^'<]*)')/y;
const END_TAG = /<\/([A-Za-z_][\w.:-]*)[ \t\r\n]*>/y;
const DECLARATION = /^<!(DOCTYPE|ENTITY|ELEMENT|ATTLIST|NOTATION)/i;
const PREDEFINED: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

function allowedCodePoint(code: number): boolean {
  return (
    code === 0x9 ||
    code === 0xa ||
    code === 0xd ||
    (code >= 0x20 && code <= 0xd7ff) ||
    (code >= 0xe000 && code <= 0xfffd) ||
    (code >= 0x10000 && code <= 0x10ffff)
  );
}

/** Character data with its references read: the five predefined entities and numeric references, nothing else. */
function decode(raw: string): string {
  if (!raw.includes("&")) return raw;
  let out = "";
  let at = 0;
  for (;;) {
    const amp = raw.indexOf("&", at);
    if (amp < 0) return out + raw.slice(at);
    out += raw.slice(at, amp);
    const semi = raw.indexOf(";", amp + 1);
    const ref = semi < 0 ? "" : raw.slice(amp + 1, semi);
    if (/^#[0-9]{1,7}$/.test(ref) || /^#x[0-9a-fA-F]{1,6}$/.test(ref)) {
      const code = ref[1] === "x" ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10);
      if (!allowedCodePoint(code)) refuse("malformed", "The feed refers to a character XML does not allow.");
      out += String.fromCodePoint(code);
    } else if (/^[A-Za-z_][\w.-]*$/.test(ref)) {
      const known = PREDEFINED[ref];
      if (known === undefined) refuse("entity", `The feed uses the entity "&${ref};", which is not read here.`);
      out += known;
    } else {
      refuse("malformed", "The feed has an & that does not start a reference. It should be written &amp;.");
    }
    at = semi + 1;
  }
}

function parseXml(s: string): El {
  if (NOT_XML.test(s)) refuse("malformed", "The feed holds a character XML does not allow.");
  let i = s.charCodeAt(0) === 0xfeff ? 1 : 0;
  if (s.startsWith("<?xml", i) && /[ \t\r\n]/.test(s[i + 5] ?? "")) {
    const end = s.indexOf("?>", i);
    if (end < 0) refuse("malformed", "The XML declaration is not closed.");
    const encoding = /encoding[ \t\r\n]*=[ \t\r\n]*["']([^"']*)["']/.exec(s.slice(i, end));
    if (encoding && !/^utf-?8$/i.test(encoding[1])) refuse("not-utf8", "Only feeds in UTF-8 can be imported.");
    i = end + 2;
  }
  const stack: El[] = [];
  let root: El | null = null;
  let elements = 0;
  while (i < s.length) {
    const lt = s.indexOf("<", i);
    const textEnd = lt < 0 ? s.length : lt;
    if (textEnd > i) {
      const raw = s.slice(i, textEnd);
      const top = stack[stack.length - 1];
      if (top) top.kids.push(decode(raw));
      else if (raw.trim() !== "") refuse("malformed", "The feed has text outside its root element.");
      i = textEnd;
      continue;
    }
    if (s.startsWith("<!--", i)) {
      const end = s.indexOf("-->", i + 4);
      if (end < 0) refuse("malformed", "A comment in the feed is not closed.");
      i = end + 3;
      continue;
    }
    if (s.startsWith("<![CDATA[", i)) {
      const top = stack[stack.length - 1];
      if (!top) refuse("malformed", "The feed has a CDATA section outside its root element.");
      const end = s.indexOf("]]>", i + 9);
      if (end < 0) refuse("malformed", "A CDATA section in the feed is not closed.");
      top.kids.push(s.slice(i + 9, end));
      i = end + 3;
      continue;
    }
    if (s.startsWith("<!", i)) {
      if (DECLARATION.test(s.slice(i, i + 12))) refuse("doctype", "Feeds with a DOCTYPE or entity declarations are not imported.");
      refuse("malformed", "The feed has a markup declaration that is not read here.");
    }
    if (s.startsWith("<?", i)) {
      const end = s.indexOf("?>", i + 2);
      if (end < 0) refuse("malformed", "A processing instruction in the feed is not closed.");
      const target = /^<\?([A-Za-z_][\w.:-]*)/.exec(s.slice(i, Math.min(end, i + 80)));
      if (!target || target[1].toLowerCase() === "xml") refuse("malformed", "The feed has a misplaced XML declaration.");
      i = end + 2;
      continue;
    }
    if (s.startsWith("</", i)) {
      END_TAG.lastIndex = i;
      const end = END_TAG.exec(s);
      const top = stack.pop();
      if (!end || !top || top.name !== end[1]) refuse("malformed", `An end tag in the feed does not match ${top ? `<${top.name}>` : "any open element"}.`);
      i = END_TAG.lastIndex;
      continue;
    }
    // A start tag.
    NAME.lastIndex = i + 1;
    const name = NAME.exec(s);
    if (!name) refuse("malformed", "The feed has a < that does not start a tag. It should be written &lt;.");
    let j = NAME.lastIndex;
    const attrs: Record<string, string> = Object.create(null) as Record<string, string>;
    let count = 0;
    let selfClosing = false;
    for (;;) {
      SPACE.lastIndex = j;
      const space = SPACE.exec(s)![0].length;
      j += space;
      if (s.startsWith("/>", j)) {
        selfClosing = true;
        j += 2;
        break;
      }
      if (s[j] === ">") {
        j += 1;
        break;
      }
      ATTRIBUTE.lastIndex = j;
      const attribute = space > 0 ? ATTRIBUTE.exec(s) : null;
      if (!attribute) refuse("malformed", `The tag <${name[0]}> is not well formed.`);
      if (attribute[1] in attrs) refuse("malformed", `The tag <${name[0]}> repeats the attribute ${attribute[1]}.`);
      count += 1;
      if (count > MAX_XML_ATTRIBUTES) refuse("malformed", `The tag <${name[0]}> has too many attributes.`);
      attrs[attribute[1]] = decode(attribute[2] ?? attribute[3]);
      j = ATTRIBUTE.lastIndex;
    }
    if (root !== null && stack.length === 0) refuse("malformed", "The feed has more than one root element.");
    elements += 1;
    if (elements > MAX_XML_ELEMENTS) refuse("too-many-elements", "The feed has too many elements to import.");
    if (stack.length + 1 > MAX_XML_DEPTH) refuse("too-deep", "The feed nests elements too deeply to import.");
    const el: El = { name: name[0], attrs, kids: [] };
    const parent = stack[stack.length - 1];
    if (parent) parent.kids.push(el);
    else root = el;
    if (!selfClosing) stack.push(el);
    i = j;
  }
  if (stack.length > 0) refuse("malformed", `The element <${stack[stack.length - 1].name}> is not closed.`);
  if (root === null) refuse("malformed", "The document is empty.");
  return root;
}

// ---------------------------------------------------------------------------------------------------------------
// RSS, read from the tree.

function children(el: El, name: string): El[] {
  return el.kids.filter((k): k is El => typeof k !== "string" && k.name === name);
}

function textIn(el: El): string {
  let out = "";
  for (const kid of el.kids) {
    if (typeof kid !== "string") refuse("malformed", `The <${el.name}> element holds markup where text was expected.`);
    out += kid;
  }
  return out;
}

/** The trimmed text of the one child with this name, null when there is none; two of them are refused. */
function field(el: El, name: string, where: string): string | null {
  const found = children(el, name);
  if (found.length > 1) refuse("malformed", `${where} has more than one <${name}>.`);
  return found.length === 0 ? null : textIn(found[0]).trim();
}

function capped(value: string, max: number, what: string): string {
  if (value.length > max) refuse("field-too-long", `${what} is longer than ${max} characters. Shorten it in the feed, then import again.`);
  return value;
}

function isHttpsAddress(address: string): boolean {
  if (!/^https:\/\//i.test(address)) return false;
  let url: URL;
  try {
    url = new URL(address);
  } catch {
    return false;
  }
  const host = url.hostname.toLowerCase();
  return (
    url.protocol === "https:" &&
    url.username === "" &&
    url.password === "" &&
    host.includes(".") &&
    !host.startsWith("[") &&
    !/^[0-9.]+$/.test(host) &&
    host !== "localhost" &&
    !host.endsWith(".localhost")
  );
}

const AUDIO_TYPES: Record<string, "audio/mpeg" | "audio/mp4"> = {
  "audio/mpeg": "audio/mpeg",
  "audio/mp3": "audio/mpeg",
  "audio/mp4": "audio/mp4",
  "audio/m4a": "audio/mp4",
  "audio/x-m4a": "audio/mp4",
};

function readEpisode(item: El, n: number): ImportedEpisode {
  const where = `Episode ${n}`;
  const title = field(item, "title", where) ?? "";
  if (title === "") refuse("no-title", `${where} has no title.`);
  capped(title, MAX_IMPORT_TITLE, `${where}'s title`);
  const notes = field(item, "description", where) ?? field(item, "itunes:summary", where) ?? "";
  capped(notes, MAX_IMPORT_NOTES, `${where}'s notes`);

  const enclosures = children(item, "enclosure");
  if (enclosures.length > 1) refuse("malformed", `${where} has more than one audio file.`);
  const url = (enclosures[0]?.attrs.url ?? "").trim();
  if (url === "") refuse("audio-missing", `${where} has no audio file.`);
  capped(url, MAX_IMPORT_URL, `${where}'s audio address`);
  if (!isHttpsAddress(url)) refuse("audio-not-https", `${where}'s audio address must be a public https:// address.`);

  const type = (enclosures[0].attrs.type ?? "").trim().toLowerCase();
  const contentType = type === "" ? null : AUDIO_TYPES[type];
  if (contentType === undefined) refuse("audio-type", `${where} is not an MP3 or M4A audio file.`);

  const length = (enclosures[0].attrs.length ?? "").trim();
  if (length !== "" && !/^[0-9]{1,15}$/.test(length)) refuse("bad-length", `${where}'s file size is not a whole number.`);
  const size = length === "" ? 0 : Number(length);
  if (!Number.isSafeInteger(size)) refuse("bad-length", `${where}'s file size is not a whole number.`);

  const date = field(item, "pubDate", where) ?? "";
  let at: number | null = null;
  if (date !== "") {
    const ms = Date.parse(date);
    if (!Number.isFinite(ms) || ms <= 0) refuse("bad-date", `${where}'s date cannot be read.`);
    at = Math.floor(ms / 1000);
  }
  const guid = field(item, "guid", where) ?? "";
  capped(guid, MAX_IMPORT_GUID, `${where}'s id`);

  return {
    title,
    notes,
    notesHaveMarkup: /<[A-Za-z/!][^>]*>/.test(notes),
    audioUrl: url,
    bytes: size > 0 ? size : null,
    contentType,
    at,
    guid: guid === "" ? null : guid,
  };
}

function readShow(root: El): ImportedShow {
  if (root.name !== "rss") refuse("not-rss", "This is not an RSS feed.");
  const channels = children(root, "channel");
  if (channels.length !== 1) refuse("not-rss", "An RSS feed has exactly one <channel>.");
  const channel = channels[0];
  const title = field(channel, "title", "The show") ?? "";
  if (title === "") refuse("no-title", "The show has no title.");
  capped(title, MAX_IMPORT_SHOW_TITLE, "The show's title");
  const description = field(channel, "description", "The show") ?? field(channel, "itunes:summary", "The show") ?? "";
  capped(description, MAX_IMPORT_SHOW_DESCRIPTION, "The show's description");
  const language = (field(channel, "language", "The show") ?? "").toLowerCase();
  const author = field(channel, "itunes:author", "The show") ?? "";
  capped(author, MAX_IMPORT_SHOW_AUTHOR, "The show's author");

  const cover = (children(channel, "itunes:image")[0]?.attrs.href ?? children(channel, "image").map((i) => field(i, "url", "The show's image"))[0] ?? "").trim();
  const coverOk = cover !== "" && cover.length <= MAX_IMPORT_URL && isHttpsAddress(cover);

  const items = children(channel, "item");
  if (items.length === 0) refuse("empty", "The feed has no episodes to import.");
  if (items.length > MAX_IMPORT_ITEMS) refuse("too-many-episodes", `The feed has ${items.length} episodes; a podcast here holds at most ${MAX_IMPORT_ITEMS}.`);
  return {
    title,
    description,
    language: /^[a-z]{2,3}(-[a-z0-9]{2,8})*$/.test(language) ? language : null,
    author: author === "" ? null : author,
    image: coverOk ? cover : null,
    imageRefused: cover !== "" && !coverOk,
    episodes: items.map((item, n) => readEpisode(item, n + 1)),
  };
}

function asText(input: unknown): string {
  if (typeof input === "string") {
    if (input.length > MAX_IMPORT_BYTES) refuse("too-large", `The feed is larger than ${MAX_IMPORT_BYTES / 1024 / 1024} MB.`);
    if (input.length * 3 > MAX_IMPORT_BYTES && new TextEncoder().encode(input).length > MAX_IMPORT_BYTES) {
      refuse("too-large", `The feed is larger than ${MAX_IMPORT_BYTES / 1024 / 1024} MB.`);
    }
    return input;
  }
  if (input instanceof Uint8Array) {
    if (input.byteLength > MAX_IMPORT_BYTES) refuse("too-large", `The feed is larger than ${MAX_IMPORT_BYTES / 1024 / 1024} MB.`);
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(input);
    } catch {
      return refuse("not-utf8", "Only feeds in UTF-8 can be imported.");
    }
  }
  return refuse("malformed", "The feed is not text.");
}

/** Reads a podcast's RSS feed: the whole show, or a refusal with its reason and no show. Never makes a request. */
export function parseRssImport(input: string | Uint8Array): RssImportResult {
  try {
    return { ok: true, show: readShow(parseXml(asText(input))) };
  } catch (error) {
    if (error instanceof Refusal) return { ok: false, reason: error.reason, detail: error.detail };
    throw error;
  }
}
