/**
 * Finds, in the code, every file that may keep something per person
 * (tests/person-data-registry.test.ts holds each to an entry of
 * lib/person-data.ts). Three signs, any one enough:
 *
 *   - a database key made with something that names a person in it: an
 *     address, a person's or member's key, a student, a buyer, "who";
 *   - a write whose field, member or value names one the same way;
 *   - a file that writes to the database and works with addresses or the
 *     keys made from them (normaliseEmail, emailKey, personKey and the rest);
 *   - a file that writes a file to the file store (writeFileWhole, Blob's put)
 *     with a buyer's or a person's address in reach (sale.email, buyer.email,
 *     customer_email...): an address inside a file is kept as surely as one in
 *     a key (audit R12, item 1: the stamped copies of lib/pdf-stamp.ts).
 *
 * It errs toward finding too much: a file it finds that keeps nothing about
 * a store's people says so in the registry, in a sentence.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const PERSON = /\b(email|emails|rawEmail|address|addr|person|people|who|member|members|student|learner|buyer|viewer|subscriber|attendee|guest|reader|readers|recipient|recipients|emailKey|addressKey|addressHash|personKey|personOf|memberKey|buyerHash|author)\b/;
const HANDLES = /\b(normaliseEmail|EMAIL_PATTERN|personKey|emailKey|addressKey|addressHash|memberKey|buyerHash|personOf)\b/;
const WRITES = /\[\s*"(HSET|HSETNX|HMSET|SET|SADD|ZADD|RPUSH|LPUSH|HINCRBY|ZINCRBY|PFADD|LSET|APPEND|EVAL)"/;
/** Writing a whole file to the file store, through lib/file-store.ts or Blob's own put. */
const FILE_WRITES = /\b(writeFileWhole|put)\s*\(/;
/** A buyer's or a person's address, as the code that has one in hand names it. */
const ADDRESS_IN_HAND = /\b(sale|buyer|order|person|customer|session)\.email\b|\bcustomer_email\b/;

function walk(root: string, dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(join(root, dir))) {
    const path = `${dir}/${name}`;
    if (statSync(join(root, path)).isDirectory()) walk(root, path, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(path);
  }
  return out;
}

/** A template literal from src[i] (a backtick): its text with "${}" for each part, and the parts. */
function readTemplate(src: string, i: number): { end: number; text: string; parts: string[] } {
  let j = i + 1;
  let text = "";
  const parts: string[] = [];
  while (j < src.length) {
    const c = src[j];
    if (c === "\\") {
      text += src.slice(j, j + 2);
      j += 2;
      continue;
    }
    if (c === "`") return { end: j + 1, text, parts };
    if (c === "$" && src[j + 1] === "{") {
      let depth = 1;
      let k = j + 2;
      const start = k;
      while (k < src.length && depth) {
        if (src[k] === "`") {
          k = readTemplate(src, k).end;
          continue;
        }
        if (src[k] === "{") depth += 1;
        else if (src[k] === "}") depth -= 1;
        k += 1;
      }
      parts.push(src.slice(start, k - 1));
      text += "${}";
      j = k;
      continue;
    }
    text += c;
    j += 1;
  }
  return { end: j, text, parts };
}

export type Finding = { file: string; keys: string[]; writes: number; handles: boolean; files?: boolean };

/** Every file of app/ and lib/ that shows a sign, with the key prefixes it makes from a person. */
export function personFiles(root: string): Finding[] {
  const files = [...walk(root, "lib"), ...walk(root, "app")];
  const out: Finding[] = [];
  for (const file of files) {
    const src = readFileSync(join(root, file), "utf8");
    // An address written into a file is kept whether or not the file also writes to the database.
    const files = FILE_WRITES.test(src) && ADDRESS_IN_HAND.test(src);
    if (!/redisPipeline|redis\.pipeline/.test(src)) {
      if (files) out.push({ file, keys: [], writes: 0, handles: false, files });
      continue;
    }
    const keys = new Set<string>();
    for (let at = src.indexOf("`"); at >= 0; ) {
      const t = readTemplate(src, at);
      const keyLike = t.text.startsWith("nl:") || /^\$\{\}:/.test(t.text);
      if (keyLike && t.parts.some((p) => PERSON.test(p))) keys.add(t.text.split("${}")[0] || "${base}");
      at = src.indexOf("`", t.end);
    }
    let writes = 0;
    for (const m of src.matchAll(/\[\s*"(HSET|HSETNX|HMSET|SADD|ZADD|RPUSH|LPUSH|HINCRBY|ZINCRBY|LSET)"\s*,([^\]\n]*)\]/g)) {
      if (PERSON.test(m[2].split(",").slice(1).join(","))) writes += 1;
    }
    const handles = WRITES.test(src) && HANDLES.test(src);
    if (keys.size || writes || handles || files) out.push({ file, keys: [...keys].sort(), writes, handles, ...(files ? { files } : {}) });
  }
  return out.sort((a, b) => a.file.localeCompare(b.file));
}
