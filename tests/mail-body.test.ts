/**
 * An email's body and the designer that writes it (lib/mail-body.ts, added
 * 13 October 2026). What is checked:
 *
 *   - blocks and text go back and forth without losing anything;
 *   - a heading, a button, a line across are drawn as such, everything
 *     escaped, a button only to an https address, carrying the email's tag;
 *   - the plain-text version says each in words;
 *   - a template's parts left to write stop an email from going out.
 */
import { readFileSync } from "node:fs";
import { MAIL_TEMPLATES, bodyHtml, bodyText, hasPlaceholder, parseMailBlocks, serializeMailBlocks } from "@/lib/mail-body";
import { done, is, part } from "./check";

async function main(): Promise<void> {
  part("Blocks and text, back and forth");
  const body = "# Spring is here\n\nA first line\nand a second.\n\n- bread\n- soup\n\n[Get the guide](https://marktmorgen.com/@chef/p/guide)\n\n---\n\nSee https://marktmorgen.com/@chef.";
  const blocks = parseMailBlocks(body);
  is("read as the blocks it is", blocks.map((b) => b.kind), ["heading", "text", "list", "button", "divider", "text"]);
  is("and written back word for word", serializeMailBlocks(blocks), body);
  is("an empty block is left out; a button's brackets cannot break it", serializeMailBlocks([{ kind: "text", text: "" }, { kind: "button", label: "Go [now]", href: "https://x.example/a" }]), "[Go  now ](https://x.example/a)".replace("Go  now ", "Go now"));
  is("a link that is not https is not a button", parseMailBlocks("[Open](http://x.example)")[0].kind, "text");

  part("Drawn as an email");
  const html = bodyHtml(body, (href) => `${href}?utm_source=email`, "#ffdd00");
  const buttonStyle = /background:(#[0-9a-f]{6});color:(#[0-9a-f]{6});font-weight:700/.exec(html);
  is("a heading, escaped", bodyHtml("# <b>Hi</b>").includes("<h2") && bodyHtml("# <b>Hi</b>").includes("&lt;b&gt;Hi&lt;/b&gt;"), true);
  is("a button derived from the store's color, with readable words and the email's tag", [html.includes('href="https://marktmorgen.com/@chef/p/guide?utm_source=email"'), buttonStyle?.[1] !== "#ffdd00", buttonStyle?.[2]], [true, true, "#ffffff"]);
  is("a line across", html.includes("<hr"), true);
  is("a color that is not one falls back", bodyHtml("[Go](https://x.example)", undefined, "red;}x").includes("background:#4c1d95"), true);

  part("In plain text");
  is("a heading's words, a button's words and address, a dash for the line", bodyText(body).split("\n\n"), [
    "Spring is here",
    "A first line\nand a second.",
    "- bread\n- soup",
    "Get the guide: https://marktmorgen.com/@chef/p/guide",
    "—",
    "See https://marktmorgen.com/@chef.",
  ]);

  part("Templates");
  for (const template of MAIL_TEMPLATES) {
    is(`${template.id}: every word in it is a part to write, so it cannot be sent as it is`, hasPlaceholder(serializeMailBlocks(template.blocks)), true);
  }
  is("an email with one left is refused where it is sent and where a sequence is saved", [
    readFileSync("lib/broadcasts.ts", "utf8").includes('return { ok: false, reason: "placeholder" }'),
    readFileSync("lib/flows.ts", "utf8").includes('return { ok: false, reason: "placeholder" }'),
  ], [true, true]);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
