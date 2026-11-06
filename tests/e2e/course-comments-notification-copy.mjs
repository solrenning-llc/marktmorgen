// Actual comment studio and successful reply UI; every request is intercepted.
// node tests/e2e/course-comments-notification-copy.mjs
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { build } from "esbuild";

const root = resolve("."), require = createRequire(root + "/package.json");
const bundle = await build({
  stdin: { contents: `
    import React from 'react';import {createRoot} from 'react-dom/client';
    import {CourseCommentsStudio} from '@/components/course-comments-studio';
    const comment={id:'parent000001',lessonId:'lessonone001',lessonTitle:'Lesson fixture',name:'Student fixture',fromCreator:false,text:'A question',at:100,hidden:false,answerTo:null,parentId:null,fresh:false};
    createRoot(document.getElementById('root')).render(<CourseCommentsStudio productId="product001" storeName="Reply proof" initialOn={true} initial={[comment]} lessonHref="/@replyproof/course/product001" now={200}/>);
  `, resolveDir: root, loader: "tsx" },
  bundle: true, write: false, platform: "browser", format: "iife", jsx: "automatic",
  alias: { "@": root }, define: { "process.env.NODE_ENV": '"production"' }, logLevel: "error",
});
const browser = await require("playwright-core").chromium.launch({ headless: true, ...(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {}) });
let checks = 0, failures = 0;
function is(name, got, expected) {
  checks++;
  const ok = JSON.stringify(got) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`${ok ? "ok" : "FAIL"} ${name}${ok ? "" : `: expected ${JSON.stringify(expected)}, got ${JSON.stringify(got)}`}`);
}
try {
  const page = await browser.newPage(), posted = [], errors = [];
  page.setDefaultTimeout(5000);
  page.on("pageerror", error => errors.push(error.message));
  await page.route("**/*", route => route.abort());
  await page.route("https://course.test/", route => route.fulfill({ contentType: "text/html", body: '<!doctype html><html lang="en"><title>Course answer check</title><body><main id="root"></main></body></html>' }));
  await page.route("https://course.test/api/store/course", route => {
    posted.push(route.request().postDataJSON());
    return route.fulfill({ contentType: "application/json", body: '{"ok":true}' });
  });
  await page.goto("https://course.test/");
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  await page.getByRole("heading", { name: "Comments under lessons" }).waitFor();
  const before = await page.locator("body").innerText();
  is("the introduction explains where an answer appears", before.includes("Your answers appear under the lesson as Reply proof."), true);
  is("the introduction promises no delivered email", /student gets an email/i.test(before), false);
  await page.getByLabel("Your answer to Student fixture").fill("A stored answer");
  await page.getByRole("button", { name: "Post the answer", exact: true }).click();
  await page.getByRole("status").waitFor();
  is("the existing reply request stays unchanged", posted, [{ id: "product001", action: "cm-reply", comment: "parent000001", text: "A stored answer" }]);
  const status = await page.getByRole("status").innerText();
  is("the actual success state confirms only the answer", status, "Answered. Your reply is under the lesson.");
  is("the success state promises no delivered email", /gets an email/i.test(status), false);
  is("the browser reported no component error", errors, []);
} finally { await browser.close(); }
console.log(`${checks} checks, ${failures} failing.`);
process.exitCode = failures ? 1 : 0;
