/**
 * A live preview at phone width beside the email editor (487 [IT4], pattern 7;
 * added 1 November 2026; components/mail-designer.tsx). Checked:
 *
 *   - the email shows "As it is sent" in both Write and Design, not only in
 *     Design, so the creator sees it while typing;
 *   - it starts at phone width (390 px, as the page editor's preview), with a
 *     Phone or Wide choice that says which is on;
 *   - it is drawn by the same function that draws the email (bodyHtml), so it
 *     cannot show something the email does not;
 *   - the email composer and every sequence step get it, as both use this editor.
 */
import { readFileSync } from "node:fs";
import { done, is } from "./check";

const designer = readFileSync("components/mail-designer.tsx", "utf8");
is("one preview, drawn by the email's own function", (designer.match(/bodyHtml\(body, undefined, accent\)/g) ?? []).length, 1);
is("shown in Write as well as in Design", (designer.match(/\{preview\}/g) ?? []).length, 3);
is("in Write it sits beside the text on a wide screen and is folded on a narrow one", designer.includes('<div className="hidden xl:block">{preview}</div>') && designer.includes('<details className="xl:hidden">') && designer.includes("See it as it is sent</summary>"), true);
is("it is inert: out of the outline, the Tab order and clicks that would leave the draft, and says why", /inert\s+className="mx-auto/.test(designer) && designer.includes("Nothing in it can be pressed here."), true);
is("it starts at phone width, 390 px", designer.includes("const [phone, setPhone] = useState(true);") && designer.includes("style={phone ? { maxWidth: 390 } : undefined}"), true);
is("a Phone or Wide choice that says which is on", designer.includes('aria-label="Preview width"') && /aria-pressed=\{phone\}[\s\S]{0,200}?Phone/.test(designer) && /aria-pressed=\{!phone\}[\s\S]{0,200}?Wide/.test(designer), true);
const studio = readFileSync("components/email-studio.tsx", "utf8");
is("the composer and every sequence step use this editor", (studio.match(/<MailBodyEditor/g) ?? []).length, 2);
is("an empty preview says so in text at 7:1 or more on white (#57534e is 7.6:1)", designer.includes('color:#57534e\\">Nothing yet.') , true);

const blog = readFileSync("components/blog-editor.tsx", "utf8");
is("the blog post is previewed by the published page's own drawing, in the store's look", blog.includes("<PostBody body={body} />") && blog.includes("lookStyle(look)") && blog.includes("st-theme-${look.theme}"), true);
is("it starts at phone width, with a Phone or Wide choice, and is inert", blog.includes("const [phone, setPhone] = useState(true);") && blog.includes('aria-label="Preview width"') && /inert[\s\S]{0,300}?className=\{`st-page/.test(blog), true);
is("beside the text on a wide screen, folded on a narrow one", blog.includes('<div className="hidden xl:block">{preview}</div>') && blog.includes("See it as it is published</summary>"), true);
is("the studio's blog page hands the editor its store's look", readFileSync("app/studio/blog/page.tsx", "utf8").includes("look={store.look}"), true);
is("Wide is the published page's own width, and the title its size", blog.includes("maxWidth: phone ? 390 : 672") && blog.includes('${phone ? "text-3xl" : "text-4xl"}'), true);

const course = readFileSync("components/course-editor.tsx", "utf8");
is("a lesson's text is previewed by the lesson page's own drawing, in the store's look", course.includes("<LessonText text={now} />") && course.includes("lookStyle(storeLook)") && course.includes("st-theme-${storeLook.theme}") && course.includes('color: "var(--st-text)"'), true);
is("it starts at phone width, with a Phone or Wide choice, is inert, and folds on a narrow screen", course.includes("const [phone, setPhone] = useState(true);") && course.includes('aria-label="Preview width"') && /inert[\s\S]{0,300}?className=\{`st-page/.test(course) && course.includes("See it as students see it</summary>"), true);
is("the studio's course page hands the editor its store's look", readFileSync("app/studio/course/[product]/page.tsx", "utf8").includes("look={store.look}"), true);
is("the lesson's words sit in the same card the lesson page puts behind them", course.includes('<div className="st-card p-5 sm:p-8">') && readFileSync("app/[handle]/course/[product]/[lesson]/page.tsx", "utf8").includes("st-card min-w-0 p-5 sm:p-8"), true);

const productView = readFileSync("components/product-about-view.tsx", "utf8");
const productPage = readFileSync("app/[handle]/p/[product]/page.tsx", "utf8");
const productEditor = readFileSync("components/product-editor.tsx", "utf8");
is("the product page draws its description with the shared component, and keeps no copy of its own", productPage.includes('import { ProductAbout } from "@/components/product-about-view";') && productPage.includes("<ProductAbout blocks={blocks} language={store.language} />") && !productPage.includes("function About("), true);
is("the product form previews the title, summary and description with that same component, in the store's look", productEditor.includes("<ProductAbout blocks={aboutBlocks(draft.about)} language={preview.language} />") && productEditor.includes("lookStyle(preview.look)"), true);
is("it says the price and the Buy button are not in it, rather than guessing them", productEditor.includes("The price and the Buy button aren&apos;t shown here: your page adds them from what you save."), true);
is("in the store's language, at the page's width, with the page's title size and card padding", productEditor.includes("lang={LANGUAGES[preview.language]?.locale") && productEditor.includes("maxWidth: phone ? 390 : 672") && productEditor.includes('${phone ? "text-2xl" : "text-3xl"}') && productEditor.includes('${phone ? "p-6" : "p-8"}'), true);
is("the description keeps its whole width when there is no preview", productEditor.includes('pagePreview ? "grid min-w-0 gap-4 xl:grid-cols-2" : "min-w-0"'), true);
is("it starts at phone width, with a Phone or Wide choice, is inert, and folds on a narrow screen", /inert[\s\S]{0,300}?className=\{`st-page/.test(productEditor) && productEditor.includes("See it as buyers see it</summary>"), true);
is("the blog and lesson previews are marked in the store's language too, as their pages are (3.1.2)", blog.includes("lang={LANGUAGES[language]?.locale") && course.includes("lang={locale}") && readFileSync("app/studio/blog/page.tsx", "utf8").includes("language={parseLanguage(store.language)}") && readFileSync("app/studio/course/[product]/page.tsx", "utf8").includes("language={parseLanguage(store.language)}"), true);
done();
