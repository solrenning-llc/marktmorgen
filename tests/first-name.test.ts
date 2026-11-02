/**
 * The reader's first name in an email (370 [SU3], unit 1; added 2 November
 * 2026): the rules, on synthetic names only.
 */
import { FIRST_NAME_PROBLEMS, FIRST_NAME_TOKEN, MAX_FALLBACK, MAX_FIRST_NAME, MAX_TOKENS, cleanFallback, fillFirstName, firstNameOf, firstNameProblem, otherFields } from "@/lib/first-name";
import { bodyHtml } from "@/lib/mail-body";
import { done, is, part } from "./check";

const ch = (code: number) => String.fromCharCode(code);
const T = FIRST_NAME_TOKEN;

part("The first name, as typed");
is("the first word", [firstNameOf("Ana Souza"), firstNameOf("  ana  "), firstNameOf("María José Pérez")], ["Ana", "ana", "María"]);
is("hyphens, apostrophes and a middle dot inside it stay", [firstNameOf("Jean-Luc Picard"), firstNameOf("O'Neil"), firstNameOf("D’Angelo"), firstNameOf("Pol·la")], ["Jean-Luc", "O'Neil", "D’Angelo", "Pol·la"]);
is("capitals are left as typed", [firstNameOf("JOHN"), firstNameOf("mcDonald")], ["JOHN", "mcDonald"]);
is("punctuation around it goes", [firstNameOf("(Ana)"), firstNameOf("\"Bea\" Lee"), firstNameOf("Ana!"), firstNameOf("Ana🌸")], ["Ana", "Bea", "Ana", "Ana"]);
is("other scripts", [firstNameOf("Zoë"), firstNameOf("محمد علي"), firstNameOf("Ελένη"), firstNameOf("प्रिया"), firstNameOf("김민준"), firstNameOf("สมชาย")], ["Zoë", "محمد", "Ελένη", "प्रिया", "김민준", "สมชาย"]);
is("a Persian name keeps its joiner", firstNameOf(`نیما${ch(0x200c)}ی`), `نیما${ch(0x200c)}ی`);

part("When the first word may not be the first name: the fallback");
is("a title or initial with a period, a surname typed first", [firstNameOf("Dr. Ana"), firstNameOf("J. Smith"), firstNameOf("Souza, Ana")], ["", "", ""]);
is("one letter", [firstNameOf("J"), firstNameOf("A Lee")], ["", ""]);
is("a small word that starts a surname, or the first half of a joined name", [firstNameOf("de Souza"), firstNameOf("van Dijk"), firstNameOf("bin Salman"), firstNameOf("Abd al-Rahman"), firstNameOf("عبد الله")], ["", "", "", "", ""]);
is("Chinese, Japanese or Korean written in parts: the first is usually the family name", [firstNameOf("李 小龙"), firstNameOf("김 민준"), firstNameOf("小龙")], ["", "", "小龙"]);
is("a capitalized De or Van is a first name", [firstNameOf("De Andre"), firstNameOf("Van Lee")], ["De", "Van"]);

part("No name to use: the fallback");
is("missing, empty, or not a word", [firstNameOf(undefined), firstNameOf(null), firstNameOf(42), firstNameOf(""), firstNameOf("   "), firstNameOf("123"), firstNameOf("!!!")], ["", "", "", "", "", "", ""]);
is("an address, a link or markup is never said", [firstNameOf("ana@example.com"), firstNameOf("www.spam.example"), firstNameOf("buy.now.com"), firstNameOf("bit.ly/abc"), firstNameOf("evil.ru"), firstNameOf("paypal-login.support"), firstNameOf("https://x"), firstNameOf("<b>Ana</b>"), firstNameOf(T)], ["", "", "", "", "", "", "", "", ""]);
is("nothing that could make a button, a link or a placeholder", [firstNameOf("A]B"), firstNameOf("x](y"), firstNameOf("A⟦b⟧c"), firstNameOf("Ana_Lee"), firstNameOf("Ana,Lee"), firstNameOf("J.R"), firstNameOf("An🌸a")], ["", "", "", "", "", "", ""]);
is("too long is no name, never cut", [firstNameOf("A".repeat(MAX_FIRST_NAME)), firstNameOf("A".repeat(MAX_FIRST_NAME + 1))], ["A".repeat(MAX_FIRST_NAME), ""]);
is("one letter carrying hundreds of marks is no name", firstNameOf("Z" + ch(0x0301).repeat(500) + "oe"), "");
is("invisible and direction-changing characters are taken out", [firstNameOf(`A${ch(0x200b)}na`), firstNameOf(`${ch(0x202e)}Ana`), firstNameOf(`A${ch(0xad)}na`), firstNameOf(`A${ch(0x200f)}na`), firstNameOf(`Ana${ch(0)}Lee`)], ["Ana", "Ana", "Ana", "Ana", "Ana"]);
is("a line break never reaches a subject", fillFirstName(`Hi ${T}`, "Ana\r\nX-Evil: 1", "there"), "Hi Ana");
const started = Date.now();
firstNameOf("a-".repeat(40_000));
cleanFallback("a-".repeat(40_000));
is("a very long input is read at once", Date.now() - started < 200, true);

part("Other merge fields, and the token written another way");
is("found, the token aside", [otherFields("Hi {name}"), otherFields("Hi {{first_name}}"), otherFields("Hi *|FNAME|*"), otherFields("Hi %FIRSTNAME%"), otherFields("{% if x %}"), otherFields("{$name}"), otherFields("{名前}"), otherFields(`Hi ${T}`)], [["{name}"], ["{{first_name}}"], ["*|FNAME|*"], ["%FIRSTNAME%"], ["{% if x %}"], ["{$name}"], ["{名前}"], []]);
is("braces around more than a word are left alone", [otherFields("a set {1, 2}"), otherFields("{}"), otherFields("function f() { return x }"), otherFields("{\nname}")], [[], [], [], []]);
is("a near spelling is said as such", [firstNameProblem(["Hi {First_Name}"], "there"), firstNameProblem(["Hi { first_name }"], "there"), firstNameProblem(["Hi {firstname}"], "there"), firstNameProblem(["Hi {last_name}"], "there")], ["spelling", "spelling", "spelling", "unknown"]);
is("refused in any part", firstNameProblem(["Subject", "Hi *|FNAME|*"], "there"), "unknown");
is("never inside a web address", [firstNameProblem([`See https://shop.example/r?n=${T}`], "there"), firstNameProblem([`[Open](https://x.example/${T})`], "there"), firstNameProblem([`${T}, see https://shop.example`], "there")], ["in_link", "in_link", null]);
is("at most so many times in each part", [firstNameProblem([T.repeat(MAX_TOKENS)], "there"), firstNameProblem([T.repeat(MAX_TOKENS + 1)], "there")], [null, "too_many"]);

part("The fallback");
is("required where the token is used, and read only there", [firstNameProblem([`Hi ${T}`], ""), firstNameProblem([`Hi ${T}`], "there"), firstNameProblem(["Hi"], ""), firstNameProblem(["Hi"], "x".repeat(MAX_FALLBACK + 1))], ["fallback", null, null, null]);
is("plain words, of a length", [cleanFallback("  there  "), cleanFallback("x".repeat(MAX_FALLBACK)), cleanFallback("x".repeat(MAX_FALLBACK + 1)), cleanFallback("see www.x.com"), cleanFallback(T), cleanFallback("[x]"), cleanFallback("dear\nfriend")], [{ ok: true, text: "there" }, { ok: true, text: "x".repeat(MAX_FALLBACK) }, { ok: false, why: "fallback_long" }, { ok: false, why: "fallback_words" }, { ok: false, why: "fallback_words" }, { ok: false, why: "fallback_words" }, { ok: true, text: "dear friend" }]);
is("each problem says how to fix it", FIRST_NAME_PROBLEMS, {
  fallback: "Write the word to use when we do not know a reader's name, such as “there” in “Hi {first_name}”.",
  fallback_long: `The word to use when we do not know a name can be up to ${MAX_FALLBACK} characters. Make it shorter.`,
  fallback_words: "Use plain words only, such as “there”. Take out curly braces, square brackets, < and > signs, web addresses and email addresses.",
  unknown: "Only {first_name}, written exactly like this, is filled in with a reader's name. Fix or take out the other words in curly braces.",
  spelling: "Write {first_name} exactly like this, in small letters with no spaces.",
  in_link: "A reader's name cannot go inside a web address. Move {first_name} out of the link.",
  too_many: `Use {first_name} up to ${MAX_TOKENS} times in each part of the email.`,
});

part("Filled for one reader");
is("the name, or the fallback", [fillFirstName(`Hi ${T},`, "Ana Souza", "there"), fillFirstName(`Hi ${T},`, "", "there"), fillFirstName(`Hi ${T},`, "ana@example.com", "there"), fillFirstName(`Hi ${T},`, "Dr. Ana", "there")], ["Hi Ana,", "Hi there,", "Hi there,", "Hi there,"]);
is("never “Hi ,”: no name and no usable fallback gives nothing to send", [fillFirstName(`Hi ${T},`, "", ""), fillFirstName(`Hi ${T},`, "", "x".repeat(MAX_FALLBACK + 1)), fillFirstName(`Hi ${T},`, "Ana", "")], [null, null, "Hi Ana,"]);
is("every token, in one pass", fillFirstName(`${T}, yes, ${T}.`, "Bea", "friend"), "Bea, yes, Bea.");
is("words without the token are untouched", fillFirstName("No name here {not a field}", "Ana", "there"), "No name here {not a field}");
is("one reader's name never reaches another: nothing is kept between calls", [fillFirstName(`Hi ${T}`, "Ana", "there"), fillFirstName(`Hi ${T}`, undefined, "there")], ["Hi Ana", "Hi there"]);

part("In the HTML, the name is escaped with the rest and adds no block");
const body = `Hi ${T},\n\nThanks for joining.\n\n[See the course](https://shop.example/course)`;
const filled = fillFirstName(body, "Ana", "there")!;
const plain = bodyHtml(fillFirstName(body, "Bob", "there")!);
is("same blocks and links as with a plain name", [(bodyHtml(filled).match(/<p|<a /g) ?? []).length], [(plain.match(/<p|<a /g) ?? []).length]);
is("no markup character can be a name, so none reaches the HTML", [fillFirstName(`Hi ${T}`, "Ana&Co", "there"), fillFirstName(`Hi ${T}`, "Ana\"x", "there")], ["Hi there", "Hi there"]);

done();
