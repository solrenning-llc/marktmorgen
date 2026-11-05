/**
 * 103 [E2-LESSON-MEDIA], unit 2: an explicit HTML preview in a lesson is
 * sanitized and drawn in a sandbox; ordinary HTML code remains code.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { LessonText } from "@/components/lesson-text";
import { lessonBlocks } from "@/lib/lesson-blocks";
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
  html.includes("&lt;script"),
  /\bonclick=|\bonerror=|javascript:|<img/i.test(html),
  html.includes("https://tracker.example"),
], [true, false, false]);
is("safe structural markup and an explicit HTTPS link remain", [
  html.includes("&lt;h2&gt;Welcome &lt;em&gt;inside&lt;/em&gt;&lt;/h2&gt;"),
  html.includes("https://example.com/lesson?x=1&amp;amp;y=2"),
], [true, true]);

part("Existing code");
const ordinary = renderToStaticMarkup(createElement(LessonText, { text: `${F}html\n<h2>Code only</h2>\n${F}` }));
is("the existing html language stays literal code, so old lessons do not change", [ordinary.includes("<iframe"), ordinary.includes("&lt;h2&gt;Code only&lt;/h2&gt;")], [false, true]);

done();
