/**
 * AX274, WCAG 1.4.12 Text Spacing, 1.4.10 Reflow and 2.5.5 Target Size
 * (Enhanced), in a student's community. Chromium on 13 November 2026, a synthetic
 * store's community, every community page at 1280 px and with the 1.4.12 spacing:
 * the header's way home cut the community's name ("Learn Kitchen Community") and
 * the line "by Learn Kitchen · back to the store" with an ellipsis, even for that
 * short name, and the link itself was 40 px tall.
 *
 * What must hold: the community's name and the "by" line wrap (break-words)
 * instead of being cut, and the way home is at least 44 px tall (min-h-11).
 */
import { readFileSync } from "node:fs";
import { done, is, part } from "./check";

const source = readFileSync("components/community-parts.tsx", "utf8");
const classOf = (marker: string, tag: string) => {
  const at = source.indexOf(marker);
  const open = source.lastIndexOf(`<${tag}`, at);
  return at < 0 || open < 0 ? [] : (source.slice(open, at + marker.length + 200).match(/className="([^"]*)"/)?.[1] ?? "").split(/\s+/);
};

part("The community header's way home keeps every word and a 44 px target");
const home = classOf('className="cm-home', "Link");
is("the way home is found", home.includes("cm-home"), true);
is("it is at least 44 px tall", home.includes("min-h-11"), true);
const name = classOf("{config.name}</span>", "span");
is("the community's name wraps instead of being cut", name.length > 1 && !name.includes("truncate") && name.includes("break-words"), true);
const by = classOf("{w.byStore(store.name)}</span>", "span");
is("the by line wraps instead of being cut", by.length > 1 && !by.includes("truncate") && by.includes("break-words"), true);

done();
