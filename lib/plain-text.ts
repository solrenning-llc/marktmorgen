/**
 * HTML turned into plain words, one way for every reader that needs it
 * (CodeQL js/incomplete-multi-character-sanitization): a tag is taken out
 * again and again until none is left, so tags nested to rebuild one after a
 * pass go too, and a "<" left unclosed that would still open one is dropped.
 * Entities are read once, by the caller's own table, only after the markup is
 * gone, so "&lt;b&gt;" is the text "<b>" the page showed, never a tag read
 * again and never "&amp;lt;" read twice. What comes out is plain text: whoever
 * puts it into HTML escapes it, as every page and email here already does.
 */

/** The most passes a replacement is repeated: each one that changes anything only shortens the text. */
const MAX_PASSES = 64;

/**
 * A tag, a comment, a doctype or a processing instruction: "<" then a letter,
 * "/", "!" or "?", up to the next ">", as a browser reads one ("<a title='x<y'>"
 * is one tag). Taking one out can join a "<" before it to the words after it
 * ("<<b>script>"), which is why it is taken out until none is left.
 */
const TAG = /<[A-Za-z!?/][^>]*>/g;

/** What would open a tag: a "<" followed by a letter, "/", "!" or "?". A "<" before a space or a digit opens nothing. */
const TAG_START = /<(?=[A-Za-z!?/])/g;

/** `pattern` replaced by `by` until the text stops changing (at most MAX_PASSES times). `pattern` must be global. */
export function replaceUntilStable(text: string, pattern: RegExp, by: string): string {
  let current = text;
  for (let pass = 0; pass < MAX_PASSES; pass += 1) {
    const next = current.replace(pattern, by);
    if (next === current) return next;
    current = next;
  }
  return current;
}

/** Every tag taken out, each giving way to `gap`; a "<" left that would open one goes too. Signs such as "5 < 10" stay. */
export function withoutTags(html: string, gap = ""): string {
  return replaceUntilStable(html, TAG, gap).replace(TAG_START, "");
}

/**
 * HTML as plain words: every tag out (each giving way to `gap`), then the
 * entities read once by `decode`. What the entities spell is the page's own
 * text, kept as text: "&lt;b&gt;" reads "<b>", to be escaped wherever it is shown.
 */
export function htmlToPlainText(html: string, { gap = "", decode }: { gap?: string; decode: (text: string) => string }): string {
  return decode(withoutTags(html, gap));
}
