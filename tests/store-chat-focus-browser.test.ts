/**
 * Issue #3991: the keyboard focus and the status messages of the store chat (components/store-chat.tsx) and the Store
 * assistant (components/store-assistant.tsx), in local Chromium with the real components; every outside request is
 * refused and the two APIs answer with synthetic threads.
 * - Opening the panel from its button takes the focus into it; Close and Escape take it back to the button, never to
 *   the page itself (WCAG 2.2 SC 2.4.3 Focus Order, 2.1.1 Keyboard; the WAI-ARIA APG dialog pattern).
 * - A part of the panel that goes away with the focus on it ("Start a new conversation", "Delete this chat", the
 *   switch to and from the form that asks the creator, the month's replies spent) leaves the focus on the field of the
 *   form that replaces it (2.4.3).
 * - "Sent", "Deleted." and the month's replies spent are said in a status region that is there before they are
 *   (4.1.3 Status Messages), and the conversation's live region is there before the first message.
 */
import { execFileSync } from "node:child_process";
import { done, is, part } from "./check";

const browserScript = String.raw`
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
const root=process.cwd(), require=createRequire(pathToFileURL(root+'/package.json'));
const {build}=require('esbuild'), {chromium}=require('playwright-core');
const bundle=async(name,component)=>(await build({stdin:{contents:[
 'import React from "react";',
 'import {createRoot} from "react-dom/client";',
 'import {'+name+'} from "@/components/'+component+'";',
 'createRoot(document.getElementById("root")).render(React.createElement('+name+',{handle:"synthetic-store",storeName:"Synthetic Store",language:"en"}));'
].join('\n'),loader:'tsx',resolveDir:root},bundle:true,platform:'browser',write:false,alias:{'@':root},define:{'process.env.NODE_ENV':JSON.stringify('production')},logLevel:'error'})).outputFiles[0].text;
const chat=await bundle('StoreChat','store-chat');
const assistant=await bundle('StoreAssistant','store-assistant');
// Same installed-browser selection as tests/checkout-focus-browser.test.ts; never download a browser.
async function launch() {
 const options={headless:true,args:['--no-sandbox']};
 if(process.env.CHROMIUM)return chromium.launch({...options,executablePath:process.env.CHROMIUM});
 try{return await chromium.launch(options);}catch(first){
  try{return await chromium.launch({...options,channel:'chrome'});}catch{throw first;}
 }
}
const TOKEN='a'.repeat(32);
let browser;
try {
 browser=await launch();
 const out={chat:{},assistant:{},errors:[],outside:0};
 const open=async(script,api,answer)=>{
  const page=await browser.newPage();
  page.on('pageerror',error=>out.errors.push(error.message));
  await page.route('**/*',async route=>{
   const url=new URL(route.request().url());
   if(url.origin!=='https://store.test'){out.outside++;return route.abort();}
   if(url.pathname==='/')return route.fulfill({contentType:'text/html',body:'<!doctype html><html lang="en"><body><a href="#top">Synthetic page link</a><div id="root"></div></body></html>'});
   if(url.pathname===api)return route.fulfill({contentType:'application/json',body:JSON.stringify(answer(JSON.parse(route.request().postData()||'{}')))});
   return route.abort();
  });
  await page.goto('https://store.test/');
  await page.addScriptTag({content:script});
  await page.waitForSelector('button[aria-expanded]');
  return page;
 };
 const where=page=>page.evaluate(()=>{
  const a=document.activeElement;
  if(!a||a===document.body)return 'body';
  if(a.matches('button[aria-expanded]'))return 'launcher';
  const dialog=a.closest('[role=dialog]');
  if(!dialog)return 'outside';
  if(a.matches('h2'))return 'title';
  if(a.closest('[data-assistant-handoff]'))return 'handoff '+a.tagName.toLowerCase()+(a.getAttribute('type')==='email'||a.id.endsWith('-email')?' email':'');
  return a.tagName.toLowerCase()+(a.id.endsWith('-email')?' email':'');
 });
 const status=page=>page.evaluate(()=>[...document.querySelectorAll('[role=dialog] [role=status]')].map(s=>s.textContent.trim()));
 const press=async(page,selector)=>{await page.focus(selector);await page.keyboard.press('Enter');};
 const expanded=page=>page.evaluate(()=>document.querySelector('button[aria-expanded]').getAttribute('aria-expanded'));

 // The store chat.
 {
  const page=await open(chat,'/api/store/chat',body=>({ok:true,thread:{token:TOKEN,status:'open',messages:[{at:1,from:'visitor',text:body.text||'Hello there'}]}}));
  await press(page,'button[aria-expanded]');
  await page.waitForSelector('[role=dialog]');
  out.chat.opened=await where(page);
  out.chat.liveBefore=await page.evaluate(()=>document.querySelectorAll('[role=dialog] [data-chat-thread][aria-live]').length);
  out.chat.statusBefore=await status(page);
  await page.keyboard.press('Escape');
  await page.waitForFunction(()=>!document.querySelector('[role=dialog]'));
  out.chat.escaped={on:await where(page),expanded:await expanded(page)};
  await press(page,'button[aria-expanded]');
  await page.waitForSelector('[role=dialog]');
  await press(page,'[role=dialog] h2 + button');
  await page.waitForFunction(()=>!document.querySelector('[role=dialog]'));
  out.chat.closed=await where(page);
  await press(page,'button[aria-expanded]');
  await page.waitForSelector('[role=dialog]');
  await page.fill('#store-chat-email','buyer@example.com');
  await page.fill('[role=dialog] textarea','Hello there, a synthetic question.');
  await press(page,'[role=dialog] button[type=submit]');
  await page.waitForSelector('[data-chat-thread] p');
  out.chat.sentStatus=await status(page);
  await press(page,'[role=dialog] form button[type=button]');
  await page.waitForSelector('#store-chat-email');
  out.chat.newChat=await where(page);
  // Escape while the person is elsewhere on the page closes the panel and leaves the focus where it is.
  await page.focus('a[href="#top"]');
  await page.keyboard.press('Escape');
  await page.waitForFunction(()=>!document.querySelector('[role=dialog]'));
  out.chat.escapedElsewhere=await where(page);
  await page.close();
 }

 // The Store assistant.
 {
  let spent=false;
  const page=await open(assistant,'/api/store/assistant',body=>{
   if(body.action==='ask')return spent?{ok:false,error:'spent'}:{ok:true,thread:{token:TOKEN,turns:[{at:1,from:'buyer',text:body.text},{at:2,from:'ai',text:'A synthetic answer.',status:'answer'}]}};
   if(body.action==='handoff')return {ok:true,thread:null};
   return {ok:true};
  });
  await press(page,'button[aria-expanded]');
  await page.waitForSelector('[role=dialog]');
  out.assistant.opened=await where(page);
  out.assistant.statusBefore=await status(page);
  await press(page,'[role=dialog] form button[type=button]');
  await page.waitForSelector('[data-assistant-handoff]');
  out.assistant.toHandoff=await where(page);
  await press(page,'[data-assistant-handoff] button[type=button]');
  await page.waitForFunction(()=>!document.querySelector('[data-assistant-handoff]'));
  out.assistant.backFromHandoff=await where(page);
  await page.fill('[role=dialog] textarea','Is there a synthetic answer?');
  await press(page,'[role=dialog] button[type=submit]');
  await page.waitForSelector('[data-assistant-thread] [data-ai-label]');
  await press(page,'[role=dialog] p button');
  await page.waitForFunction(()=>!document.querySelector('[data-assistant-thread] [data-ai-label]'));
  out.assistant.deleted={on:await where(page),status:await status(page)};
  // Handed over and sent: back to the question, "Sent" said.
  await press(page,'[role=dialog] form button[type=button]');
  await page.waitForSelector('[data-assistant-handoff]');
  await page.fill('#store-assistant-email','buyer@example.com');
  await page.fill('[data-assistant-handoff] textarea','A synthetic question for the creator.');
  await press(page,'[data-assistant-handoff] button[type=submit]');
  await page.waitForFunction(()=>!document.querySelector('[data-assistant-handoff]'));
  out.assistant.handedOver={on:await where(page),status:await status(page)};
  // The month's replies spent: the form that asks the creator, with the focus on its field.
  spent=true;
  await page.fill('[role=dialog] textarea','One more synthetic question?');
  await press(page,'[role=dialog] button[type=submit]');
  await page.waitForSelector('[data-assistant-handoff]');
  out.assistant.spent={on:await where(page),status:await status(page)};
  await page.keyboard.press('Escape');
  await page.waitForFunction(()=>!document.querySelector('[role=dialog]'));
  out.assistant.escaped={on:await where(page),expanded:await expanded(page)};
  await press(page,'button[aria-expanded]');
  await page.waitForSelector('[role=dialog]');
  await press(page,'[role=dialog] h2 + button');
  await page.waitForFunction(()=>!document.querySelector('[role=dialog]'));
  out.assistant.closed=await where(page);
  await page.close();
 }
 console.log(JSON.stringify(out));
} finally {
 if(browser)await browser.close();
}
`;

type Where = string;
const result = JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", browserScript], { encoding: "utf8", timeout: 120_000, maxBuffer: 2_000_000 })) as {
  chat: { opened: Where; liveBefore: number; statusBefore: string[]; escaped: { on: Where; expanded: string }; closed: Where; sentStatus: string[]; newChat: Where; escapedElsewhere: Where };
  assistant: {
    opened: Where;
    statusBefore: string[];
    toHandoff: Where;
    backFromHandoff: Where;
    deleted: { on: Where; status: string[] };
    handedOver: { on: Where; status: string[] };
    spent: { on: Where; status: string[] };
    escaped: { on: Where; expanded: string };
    closed: Where;
  };
  errors: string[];
  outside: number;
};
const { chat, assistant } = result;

part("The store chat");
is("opening it from its button takes the focus to the panel's title (2.4.3)", chat.opened, "title");
// The conversation is not a live region: only an answer from the store is said, in the status region (tests/store-chat-reply-announced.test.ts).
is("its conversation is not a live region, and its status region is there before anything is said (4.1.3)", [chat.liveBefore, chat.statusBefore], [0, [""]]);
is("Escape takes the focus back to the button, now collapsed", chat.escaped, { on: "launcher", expanded: "false" });
is("Close takes the focus back to the button", chat.closed, "launcher");
is("Sent is said in the status region", chat.sentStatus, ["Sent. The answer shows here, and goes to your email too."]);
is("Start a new conversation puts the focus on the email field of the new form, never on the page", chat.newChat, "input email");
is("Escape with the focus elsewhere on the page closes the panel and leaves the focus there (3.2.5)", chat.escapedElsewhere, "outside");

part("The Store assistant");
is("opening it from its button takes the focus to the panel's title (2.4.3)", assistant.opened, "title");
is("its status region is there before anything is said (4.1.3)", assistant.statusBefore, [""]);
is("asking the creator puts the focus on the email field of that form", assistant.toHandoff, "handoff input email");
is("closing that form puts the focus back on the question", assistant.backFromHandoff, "textarea");
is("deleting the chat puts the focus on the question and says Deleted.", assistant.deleted, { on: "textarea", status: ["Deleted."] });
is("a question sent to the creator puts the focus back on the question and says Sent", assistant.handedOver, { on: "textarea", status: ["Sent. Synthetic Store answers you by email."] });
is("the month's replies spent: the focus on the email field of the form that asks the creator, and only that is said, not the earlier Sent", assistant.spent, {
  on: "handoff input email",
  status: ["The assistant has answered all it can this month. Leave your question and your email, and Synthetic Store answers you by email."],
});
is("Escape takes the focus back to the button, now collapsed", assistant.escaped, { on: "launcher", expanded: "false" });
is("Close takes the focus back to the button", assistant.closed, "launcher");

part("Nothing else");
is("the pages asked nothing outside their own synthetic store", result.outside, 0);
is("no browser error", result.errors, []);
done();
