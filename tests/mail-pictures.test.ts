/**
 * Pictures in a creator's email (lib/mail-picture-rules.ts,
 * lib/mail-pictures.ts, lib/mail.ts bodyHtml; added 10 October 2026). Checked:
 *
 *   - only a line of its own naming a JPEG kept on this site becomes a
 *     picture; one from anywhere else, a WebP, or a line with words around
 *     it stays text;
 *   - the description is made safe, and shown to readers without pictures;
 *   - an email to the list, given its store's folder, shows six at most; the
 *     rest stay text (which emails and folders: tests/mail-pictures-owner.test.ts);
 *   - only a JPEG of a sensible size and weight is kept.
 */
import { MAX_MAIL_PICTURES, MAX_MAIL_PICTURE_BYTES, pictureCount, pictureLine, pictureUrl, readPicture, withoutPictures } from "@/lib/mail-picture-rules";
import { checkMailPicture } from "@/lib/mail-pictures";
import { bodyHtml, render } from "@/lib/mail";
import type { Store } from "@/lib/store";
import { done, is, part } from "./check";

const FOLDER = "a".repeat(24);
const url = (n: number, ext = "jpg") => pictureUrl(FOLDER, `${String(n).padStart(32, "b")}.${ext}`);

function jpeg(width: number, height: number, padding = 0): string {
  const bytes = [0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 255, width >> 8, width & 255, 3, ...new Array(12 + padding).fill(0)];
  return `data:image/jpeg;base64,${Buffer.from(bytes).toString("base64")}`;
}

async function main(): Promise<void> {
  part("What is a picture");
  is("a kept JPEG on a line of its own", readPicture(`![The loaf](${url(1)})`), { alt: "The loaf", url: url(1) });
  is("with or without a description", readPicture(`![](${url(1)})`)?.alt, "");
  is("never one from elsewhere", readPicture("![x](https://example.com/api/image/aaaaaaaaaaaaaaaaaaaaaaaa/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb1.jpg)"), null);
  is("nor a WebP, which Outlook does not show", readPicture(`![x](${url(1, "webp")})`), null);
  is("nor with words around it", readPicture(`See ![x](${url(1)})`), null);
  is("the line made from a description is safe", pictureLine("A [bad]\nline", url(2)), `![A bad line](${url(2)})`);
  is("and reads back", readPicture(pictureLine("Two loaves", url(2)))?.alt, "Two loaves");

  part("In the email");
  const body = `Hello,\n\n![The loaf](${url(1)})\nIt rose.\n\n![](${url(2)})\n\n![x](https://example.com/a.jpg)`;
  const html = bodyHtml(body, undefined, undefined, FOLDER);
  is("each kept picture is drawn, at the width an email shows", (html.match(/<img /g) ?? []).length, 2);
  is("with its description, escaped", html.includes(`alt="The loaf"`) && html.includes(`src="${url(1)}"`), true);
  is("one from elsewhere stays text", html.includes("<img src=\"https://example.com"), false);
  is("the words after a picture stay a paragraph", html.includes(">It rose.</p>"), true);
  is("readers without pictures get the description, and nothing for one without", withoutPictures(body), `Hello,\n\n[The loaf]\nIt rose.\n\n\n![x](https://example.com/a.jpg)`);
  const many = Array.from({ length: MAX_MAIL_PICTURES + 2 }, (_, i) => pictureLine(`P${i}`, url(i + 1))).join("\n\n");
  is(`${MAX_MAIL_PICTURES} at most are drawn`, [pictureCount(many), (bodyHtml(many, undefined, undefined, FOLDER).match(/<img /g) ?? []).length], [MAX_MAIL_PICTURES + 2, MAX_MAIL_PICTURES]);
  const store = { handle: "bakery", name: "Oven Notes", language: "en", mail: { fromName: "Oven Notes", address: "1 Main St" } } as unknown as Store;
  const sent = render(store, "New loaf", body, "tok");
  is("the email's text version carries the description, not the address", [sent.text.includes("[The loaf]"), sent.text.includes(url(1))], [true, false]);

  part("What is kept");
  is("a JPEG of 1200 by 800", (() => {
    const checked = checkMailPicture(jpeg(1200, 800));
    return typeof checked === "object" ? [checked.width, checked.height] : checked;
  })(), [1200, 800]);
  is("never larger than an email needs", checkMailPicture(jpeg(2400, 800)), "picture");
  is("nor a WebP", checkMailPicture(`data:image/webp;base64,${Buffer.from("RIFF\0\0\0\0WEBPVP8X\0\0\0\0\0\0\0\0\x1f\x03\0\x57\x02\0", "latin1").toString("base64")}`), "picture");
  is("nor heavier than the limit", checkMailPicture(jpeg(800, 600, MAX_MAIL_PICTURE_BYTES)), "picture");
  is("nor nothing, nor anything that is not base64", [checkMailPicture(""), checkMailPicture("data:image/jpeg;base64,<x>")], ["picture", "picture"]);

  done();
}

void main();
