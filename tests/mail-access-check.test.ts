/**
 * AX274 Part A item 6 (ATAG 2.0 Part B) in the email editor: before an email goes out, the studio names a
 * picture with no words, a button whose words do not say where it goes and a bare web address read out as its
 * link, each with where it is in the text (lib/mail-access-check.ts). Checked here: what is found and what is
 * not, read exactly as the email is drawn (lib/mail-body.ts); and each one-click fix, which only uses words the
 * creator typed, never invents any, refuses vague or empty words and refuses to write over text that changed.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { bodyHtml } from "@/lib/mail-body";
import { pictureLine } from "@/lib/mail-picture-rules";
import { addressToButton, describePicture, mailAccessNotes, MAIL_ACCESS_DONE_FOR_YOU, renameButton } from "@/lib/mail-access-check";
import { MailAccessReview } from "@/components/mail-access-review";
import { done, is, part } from "./check";

const pic = (n: number) => `https://marktmorgen.com/api/image/${"a".repeat(24)}/${String(n % 10).repeat(32)}.jpg`;
const kinds = (body: string) => mailAccessNotes(body).map((note) => note.kind);

part("Nothing to say about a clear email");
is("empty", mailAccessNotes(""), []);
is("heading, words, a described picture, a clear button", kinds(["# Spring bake", "Fresh loaves this week.", pictureLine("Three sourdough loaves on a board", pic(1)), "[Read the bread guide](https://example.com/guide)"].join("\n\n")), []);
is("a divider and a list without addresses", kinds("---\n\n- Flour\n- Water"), []);

part("A picture with no words");
{
  const body = ["Hello", pictureLine("", pic(1))].join("\n\n");
  const notes = mailAccessNotes(body);
  is("named", notes.map((n) => n.kind), ["picture"]);
  const note = notes[0];
  is("its place is the picture's line", body.slice(note.start, note.end), pictureLine("", pic(1)));
  if (note.kind === "picture") is("its address", note.url, pic(1));
  is("a picture inside a paragraph is found too", kinds(`Line one\n${pictureLine("", pic(2))}\nLine two`), ["picture"]);
  const seven = Array.from({ length: 7 }, (_, i) => pictureLine("", pic(i + 1))).join("\n\n");
  // Only six pictures are drawn (MAX_MAIL_PICTURES); the seventh stays text, an address that is not https://, so not a link.
  is("only the pictures that are drawn", kinds(seven).filter((k) => k === "picture").length, 6);
}

part("A picture whose words say nothing");
{
  // "image" or a file name is read out, but says no more than nothing (WCAG 1.1.1): named, with the words it has.
  for (const alt of ["image", "Photo", "IMG_2041", "loaves.jpg", "picture 3"]) {
    const notes = mailAccessNotes(pictureLine(alt, pic(1)));
    is(`"${alt}" named`, notes.map((n) => [n.kind, n.kind === "picture" ? n.alt : null]), [["picture", alt]]);
  }
  is("a real description is not named", kinds(pictureLine("Photo of three loaves on a board", pic(1))), []);
  const note = mailAccessNotes(pictureLine("", pic(1)))[0];
  is("no words: alt is empty", note.kind === "picture" ? note.alt : null, "");
  const body = pictureLine("", pic(1));
  is("fix refuses a word that says nothing", describePicture(body, note, "image"), { ok: false, why: "vague" });
  is("fix refuses a file name", describePicture(body, note, "IMG_2041.jpg"), { ok: false, why: "vague" });
}

part("Button words that do not say where they go");
is("Click here", kinds("[Click here](https://example.com/a)"), ["button"]);
is("Read more", kinds("[Read more](https://example.com/a)"), ["button"]);
is("an address as the words", kinds("[example.com/a](https://example.com/a)"), ["button"]);
is("clear words", kinds("[Get the free bread guide](https://example.com/a)"), []);

part("A bare web address");
{
  const alone = "Intro\n\nhttps://example.com/plan";
  const notes = mailAccessNotes(alone);
  is("alone on its line: named, and can become a button", notes.map((n) => [n.kind, n.kind === "address" && n.alone]), [["address", true]]);
  is("its place is the address", alone.slice(notes[0].start, notes[0].end), "https://example.com/plan");
  const inside = "See the plan at https://example.com/plan. Then reply.";
  const said = mailAccessNotes(inside);
  is("in a sentence: named, not alone, full stop left out", said.map((n) => [n.kind, n.kind === "address" && n.alone, inside.slice(n.start, n.end)]), [["address", false, "https://example.com/plan"]]);
  is("in a list", kinds("- Flour\n- https://example.com/flour"), ["address"]);
  is("in a heading it is not a link: nothing", kinds("# https://example.com"), []);
  is("http:// is not made a link: nothing", kinds("http://example.com/plan"), []);
  // The check reads what the email draws: every address it names is a link in the HTML, with the address as its words.
  const html = bodyHtml(inside);
  is("drawn as a link whose words are the address", html.includes(">https://example.com/plan</a>"), true);
}

part("In order, as the email reads");
is("order", kinds(["[More](https://example.com/b)", pictureLine("", pic(3)), "Go to https://example.com/c"].join("\n\n")), ["button", "picture", "address"]);
{
  // Windows line ends (a text pasted or sent as a form): the email splits paragraphs after turning them into \n,
  // so a blank line made of \r\n still ends a paragraph here, and the place found is still the one checked.
  const crlf = ["Hello", "[Click here](https://example.com/b)", "See https://example.com/c"].join("\r\n\r\n");
  is("\\r\\n paragraphs: each block read", kinds(crlf), ["button", "address"]);
  const button = mailAccessNotes(crlf)[0];
  is("\\r\\n paragraphs: the button's place is its own text", crlf.slice(button.start, button.end), "[Click here](https://example.com/b)");
  // A picture on its own line inside a paragraph, with \r\n inside the paragraph too.
  const inner = ["Look:", pictureLine("", pic(4)), "More at https://example.com/d"].join("\r\n");
  const notes = mailAccessNotes(inner);
  is("\\r\\n lines: picture and address read", notes.map((n) => n.kind), ["picture", "address"]);
  is("\\r\\n lines: the picture's place is its own line", inner.slice(notes[0].start, notes[0].end), pictureLine("", pic(4)));
  is("\\r\\n lines: the address's place", inner.slice(notes[1].start, notes[1].end), "https://example.com/d");
}

part("Fixes use only the creator's words");
{
  const body = ["Hi", pictureLine("", pic(4)), "[Click here](https://example.com/a)", "https://example.com/plan"].join("\n\n");
  const [picture, button, address] = mailAccessNotes(body);
  const described = describePicture(body, picture, "  A bowl of rising dough  ");
  is("picture described with the typed words", described.ok && described.body.includes(pictureLine("A bowl of rising dough", pic(4))), true);
  is("nothing else changed", described.ok && described.body.replace(pictureLine("A bowl of rising dough", pic(4)), pictureLine("", pic(4))), body);
  is("no words: refused", describePicture(body, picture, "   "), { ok: false, why: "empty" });
  const renamed = renameButton(body, button, "Read the dough guide");
  is("button renamed, same address", renamed.ok && renamed.body.includes("[Read the dough guide](https://example.com/a)"), true);
  is("vague words: refused", renameButton(body, button, "Read more"), { ok: false, why: "vague" });
  is("too long: refused", renameButton(body, button, "x".repeat(61)), { ok: false, why: "long" });
  const made = addressToButton(body, address, "See the meal plan");
  is("a lone address becomes a button with the typed words", made.ok && made.body.endsWith("[See the meal plan](https://example.com/plan)"), true);
  const inside = "See https://example.com/plan today";
  is("an address in a sentence is not rewritten", addressToButton(inside, mailAccessNotes(inside)[0], "See the plan"), { ok: false, why: "not_alone" });
  is("text changed since: refused, nothing written", describePicture(`X${body}`, picture, "Dough"), { ok: false, why: "changed" });
  is("brackets in the words cannot break the button", renameButton(body, button, "Get [the] guide").ok && (renameButton(body, button, "Get [the] guide") as { body: string }).body.includes("[Get the guide](https://example.com/a)"), true);
  is("after the fixes, the notes are gone", made.ok ? kinds(made.body) : null, ["picture", "button"]);
}

part("What is done for every email");
is("said only for what the code does", MAIL_ACCESS_DONE_FOR_YOU.length > 0 && MAIL_ACCESS_DONE_FOR_YOU.some((l) => l.includes("7:1")), true);

part("The panel");
{
  const body = ["Hi", pictureLine("", pic(5)), "[Click here](https://example.com/a)"].join("\n\n");
  const html = renderToStaticMarkup(createElement(MailAccessReview, { body, onChange: () => undefined, onShow: () => undefined }));
  is("a titled section", html.includes("Can everyone read it?"), true);
  is("counts what it found", html.includes("2 things to check"), true);
  is("each fix is a button the creator presses", (html.match(/<button/g) ?? []).length >= 4, true);
  is("never blocks: says it can still go out", html.includes("You can still send it"), true);
  is("a polite live region for what a fix did", html.includes('role="status"'), true);
  is("no word is invented: the description box starts empty", /<input[^>]*value=""/.test(html), true);
  const clear = renderToStaticMarkup(createElement(MailAccessReview, { body: "Hello", onChange: () => undefined, onShow: () => undefined }));
  is("a clear email: says so", clear.includes("Nothing to fix"), true);
}

done();
