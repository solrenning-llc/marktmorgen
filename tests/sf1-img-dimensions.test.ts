/**
 * 281 [SF1], complement WG (b): every picture the site draws says how big it is before it arrives.
 *
 * A picture with no width and height takes no room until its bytes come in, so on a slow phone the words below it
 * jump down when it lands (layout shift, CLS). With both written on the element the browser keeps the box from the
 * first paint, whatever size the CSS then draws it at. This file reads every page and component (app/, components/)
 * and lists each <img> that leaves either out, so a new one cannot come back without them.
 *
 * The reader keeps to the element's own attributes: a width inside style={{ ... }} is not the attribute, and a
 * spread ({...props}) cannot be read, so it counts as missing.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { done, is, part } from "./check";

/** The attribute names written on the element itself, outside any {...} expression and any quoted value. */
export function imgAttributes(element: string): { names: string[]; spread: boolean } {
  const names: string[] = [];
  let spread = false;
  let depth = 0;
  let quote: string | null = null;
  let word = "";
  for (let i = 0; i < element.length; i++) {
    const c = element[i];
    if (depth === 0 && quote) {
      if (c === quote) quote = null;
      continue;
    }
    if (c === "{") {
      if (depth === 0 && element.slice(i + 1).trimStart().startsWith("...")) spread = true;
      depth++;
      word = "";
      continue;
    }
    if (c === "}") {
      depth--;
      continue;
    }
    if (depth > 0) continue;
    if (c === '"' || c === "'") {
      quote = c;
      continue;
    }
    if (/[A-Za-z0-9_-]/.test(c)) {
      word += c;
      continue;
    }
    if (c === "=" && word) names.push(word);
    word = "";
  }
  return { names, spread };
}

/** Every <img ...> element in a source file, with the line it starts on. */
export function imgElements(source: string): { line: number; element: string }[] {
  const found: { line: number; element: string }[] = [];
  let at = 0;
  while ((at = source.indexOf("<img", at)) >= 0) {
    if (!/\s/.test(source[at + 4] ?? "")) {
      at += 4;
      continue;
    }
    let depth = 0;
    let quote: string | null = null;
    let end = at + 4;
    for (; end < source.length; end++) {
      const c = source[end];
      if (depth === 0 && quote) {
        if (c === quote) quote = null;
        continue;
      }
      if (c === "{") depth++;
      else if (c === "}") depth--;
      else if (depth === 0 && (c === '"' || c === "'")) quote = c;
      else if (depth === 0 && c === ">") break;
    }
    found.push({ line: source.slice(0, at).split("\n").length, element: source.slice(at, end + 1) });
    at = end;
  }
  return found;
}

/** Whether the element names both its width and its height as attributes. */
export function declaresSize(element: string): boolean {
  const { names, spread } = imgAttributes(element);
  return !spread && names.includes("width") && names.includes("height");
}

part("The reader itself, on made-up elements");
is("both attributes: declared", declaresSize('<img src={a} alt="" width={40} height={40} />'), true);
is("numbers in quotes count too", declaresSize('<img src="/a.webp" alt="" width="40" height="40" />'), true);
is("no size at all: missing", declaresSize('<img src={a} alt="" className="h-20 w-20" />'), false);
is("width alone: missing", declaresSize('<img src={a} alt="" width={40} />'), false);
is("a width only in the style is not the attribute", declaresSize('<img src={a} alt="" style={{ width: 40, height: 40 }} />'), false);
is("a quoted alt that says width= is not the attribute", declaresSize('<img src={a} alt="width=40 height=40" />'), false);
is("an expression that holds width= is not the attribute", declaresSize('<img src={x ? "width=1" : "height=1"} alt="" />'), false);
is("a spread cannot be read, so it counts as missing", declaresSize('<img {...props} width={40} height={40} />'), false);
is("an element over several lines is read whole", imgElements('a\n<img\n  src={a}\n  alt=""\n  width={1}\n  height={2}\n/>\nb').map((e) => [e.line, declaresSize(e.element)]), [[2, true]]);
is("an arrow inside an expression does not end the element", imgElements('<img src={f((x) => x)} alt="" width={1} height={1} />').map((e) => declaresSize(e.element)), [true]);
is("<imgx> and the word img are not elements", imgElements("<imgx /> img <span>img</span>").length, 0);

part("Every picture on the site says how big it is");
const files = (dir: string): string[] =>
  readdirSync(join(process.cwd(), dir), { withFileTypes: true }).flatMap((entry) => {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory()) return files(path);
    return entry.name.endsWith(".tsx") ? [path] : [];
  });
const sources = [...files("app"), ...files("components")];
const pictures = sources.flatMap((file) => imgElements(readFileSync(file, "utf8")).map((found) => ({ file, ...found })));
const missing = pictures.filter((found) => !declaresSize(found.element)).map((found) => `${found.file}:${found.line}`);
is("the site draws pictures (the reader found them)", pictures.length > 50, true);
is("no <img> leaves out its width or height", missing, []);

part("The video's still keeps the size of the picture it shows");
const embed = readFileSync("components/video-embed.tsx", "utf8");
is("the poster it is given carries its width and height", /poster: \{ src: string; alt: string; width: number; height: number \} \| null/.test(embed), true);
const blocks = readFileSync("components/sales-blocks.tsx", "utf8");
is("the sales page's top video passes the product picture's size", blocks.includes("poster={ctx.picture ? { src: ctx.picture.src, alt: ctx.picture.alt, width: ctx.picture.width, height: ctx.picture.height } : null}"), true);

done();
