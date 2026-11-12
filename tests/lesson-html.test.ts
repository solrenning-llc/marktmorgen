/**
 * 103 [E2-LESSON-MEDIA], unit 2: an explicit HTML preview in a lesson is
 * sanitized and drawn in a sandbox; ordinary HTML code remains code.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { LessonText } from "@/components/lesson-text";
import { lessonBlocks } from "@/lib/lesson-blocks";
import { lessonHtmlDocument, sanitizeLessonHtml } from "@/lib/lesson-html";
import { done, is, part } from "./check";

const F = "`".repeat(3);
const preview = [
  `${F}html-preview`,
  '<h2 onclick="steal()">Welcome <em>inside</em></h2>',
  '<script>alert("no")</script>',
  '<img src="https://tracker.example/pixel" onerror="steal()">',
  '<a href="javascript:steal()">bad</a>',
  '<a href="https://example.com/lesson?x=1&y=2">safe</a>',
  F,
].join("\n");

part("Explicit preview");
is("the explicit language becomes a separate HTML-preview block", lessonBlocks(preview).map((block) => block.kind), ["html"]);

const html = renderToStaticMarkup(createElement(LessonText, { text: preview, htmlPreviewLabel: "HTML preview" }));
is("drawn in a named sandbox, without script permission or referrer data", [
  html.includes('<iframe title="HTML preview"'),
  html.includes('sandbox=""'),
  html.includes('referrerPolicy="no-referrer"'),
], [true, true, true]);
is("active content, event handlers, remote images and unsafe links never reach the frame", [
  html.includes("&amp;lt;script"),
  /\bonclick=|\bonerror=|javascript:|<img/i.test(html),
  html.includes("https://tracker.example"),
], [true, false, false]);
is("safe structural markup and an explicit HTTPS link remain", [
  html.includes("&lt;h2&gt;Welcome &lt;em&gt;inside&lt;/em&gt;&lt;/h2&gt;"),
  html.includes("https://example.com/lesson?x=1&amp;amp;y=2"),
], [true, true]);

part("Sanitizer boundary");
is("only the small structural vocabulary remains; every supplied attribute is removed", sanitizeLessonHtml('<p class="lead" style="background:url(https://tracker.example)">Hi <strong data-x="1">there</strong><br aria-label="x"></p>'), "<p>Hi <strong>there</strong><br></p>");
is("active, embedded, styled, form and remote-media tags become inert names without their attributes", sanitizeLessonHtml('<script src="https://tracker.example/a.js">run()</script><style>body{display:none}</style><iframe src="https://tracker.example/f"></iframe><form action="https://tracker.example/post"><input></form><img src="https://tracker.example/i"><svg onload="run()"></svg>'), "&lt;script&gt;run()&lt;/script&gt;&lt;style&gt;body{display:none}&lt;/style&gt;&lt;iframe&gt;&lt;/iframe&gt;&lt;form&gt;&lt;input&gt;&lt;/form&gt;&lt;img&gt;&lt;svg&gt;&lt;/svg&gt;");
is("only an explicit valid HTTPS href is kept", [
  sanitizeLessonHtml('<a href="https://example.com/a?x=1&y=2" onclick="run()">safe</a>'),
  sanitizeLessonHtml('<a href="http://example.com">http</a><a href="//example.com">relative</a><a href="javascript:run()">script</a><a href="data:text/html,x">data</a>'),
], ['<a href="https://example.com/a?x=1&amp;y=2">safe</a>', "<a>http</a><a>relative</a><a>script</a><a>data</a>"]);
is("entities stay text and cannot turn into a second parsing pass", sanitizeLessonHtml('&lt;script&gt;alert(1)&lt;/script&gt; &amp; text'), "&amp;lt;script&amp;gt;alert(1)&amp;lt;/script&amp;gt; &amp;amp; text");
is("malformed tags cannot smuggle an attribute or active tag into the result", [
  sanitizeLessonHtml('<h2 title=">" onclick="run()">title</h2>'),
  sanitizeLessonHtml('<a href="https://example.com/\" onclick=\"run()">link</a>'),
  sanitizeLessonHtml("plain < unfinished"),
], ['<h2>" onclick="run()"&gt;title</h2>', '<a href="https://example.com/">link</a>', "plain &lt; unfinished"]);
is("the complete document has only fixed product CSS and a no-referrer policy", [
  lessonHtmlDocument("<p>Text</p>").includes("default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"),
  lessonHtmlDocument("<p>Text</p>").includes('<meta name="referrer" content="no-referrer">'),
  lessonHtmlDocument("<p>Text</p>").includes("<style>html{color-scheme:light dark}"),
  lessonHtmlDocument('<style>@import "https://tracker.example"</style>').match(/<style>/g)?.length,
  lessonHtmlDocument('<style>@import "https://tracker.example"</style>').includes('&lt;style&gt;@import "https://tracker.example"&lt;/style&gt;'),
], [true, true, true, 1, true]);

part("Existing code");
const ordinary = renderToStaticMarkup(createElement(LessonText, { text: `${F}html\n<h2>Code only</h2>\n${F}` }));
is("the existing html language stays literal code, so old lessons do not change", [ordinary.includes("<iframe"), ordinary.includes("&lt;h2&gt;Code only&lt;/h2&gt;")], [false, true]);
is("an unclosed or empty explicit block follows the existing safe fence rules", [
  lessonBlocks(`${F}html-preview\n<p>unclosed</p>`).some((block) => block.kind === "html"),
  lessonBlocks(`${F}html-preview\n\n${F}`).length,
], [false, 0]);

done();
