import {checkGuidePlacement} from "./store-guide-placement.mjs";
import {checkHomePath} from "./home-path.mjs";
import {publicStandardAx2Run} from "./ax2-public-run.mjs";
import {checkCertificateHeading} from "./certificate-heading.mjs";
import { checkMenuMounting } from "./menu-mounting.mjs";
import { checkPurchaseResend } from "./purchase-resend-confirmation.mjs";
import { checkShippingSave } from "./shipping-save-confirmation.mjs";
import {placeholderPaint} from "./placeholder-paint.mjs";
import {checkOfferPlanning} from "./offer-planning.mjs";
import { checkPixelAttributionCenter } from "./pixel-attribution-center.mjs";
import { checkPartnerCopy } from "./partner-copy.mjs";
import { checkPublicTrustDesign } from "./public-trust-design.mjs";
import { checkTemplateLibrary } from "./template-library.mjs";
import { checkEvergreenGuides } from "./evergreen-guides.mjs";
import { checkSalesLevers } from "./sales-levers.mjs";
import { checkPlatformProof } from "./platform-proof.mjs";
import { checkCreatorShowcase } from "./creator-showcase.mjs";
import { checkSigninTerms } from "./signin-terms.mjs";
import { checkStoreActivation } from "./store-activation.mjs";
import { checkHotmartComparison } from "./hotmart-comparison.mjs";
import { checkPricingValue } from "./pricing-value.mjs";
import { checkCreatorJourney } from "./creator-journey.mjs";
import { checkHomeHero } from "./home-hero.mjs";
import { checkSitesAcknowledgment } from "./sites-acknowledgment.mjs";
import { checkLeaveAcknowledgment } from "./leave-acknowledgment.mjs";
import { checkPackageAcknowledgment } from "./package-acknowledgment.mjs";
import { checkNumbersAcknowledgment } from "./numbers-acknowledgment.mjs";
import { checkYearlyAcknowledgment } from "./yearly-acknowledgment.mjs";
import { checkDunningAcknowledgment } from "./dunning-acknowledgment.mjs";
import { checkTierAcknowledgment } from "./tier-acknowledgment.mjs";
import { checkOrderAcknowledgment } from "./order-acknowledgment.mjs";
import { checkExitAcknowledgment } from "./exit-offer-acknowledgment.mjs";
import { checkCartAcknowledgment } from "./cart-acknowledgment.mjs";
import { checkEnableAcknowledgment } from "./enable-acknowledgment.mjs";
import { checkPairsAcknowledgment } from "./pairs-acknowledgment.mjs";
import { checkCollectionsAcknowledgment } from "./collections-acknowledgment.mjs";
import { checkLayoutAcknowledgment } from "./layout-acknowledgment.mjs";
import { checkLookAcknowledgment } from "./look-acknowledgment.mjs";
import { checkLanguageAcknowledgment } from "./language-acknowledgment.mjs";
import { checkThanksAcknowledgment } from "./thanks-note-acknowledgment.mjs";
import { checkNoCountAcknowledgment } from "./no-count-acknowledgment.mjs";
import { checkNudgeAcknowledgment } from "./nudge-acknowledgment.mjs";
import { checkPdfStampAcknowledgment } from "./pdf-stamp-acknowledgment.mjs";
import { checkPdfPreviewAcknowledgment } from "./pdf-preview-acknowledgment.mjs";
import { checkFaqAcknowledgment } from "./faq-acknowledgment.mjs";
import { checkTipsAcknowledgment } from "./support-setting-acknowledgment.mjs";
import { checkIntroAcknowledgment } from "./intro-acknowledgment.mjs";
import { checkJoinAcknowledgment } from "./signup-setting-acknowledgment.mjs";
import { checkSocialAcknowledgment } from "./social-acknowledgment.mjs";
import { checkRecoveryAcknowledgment } from "./recovery-acknowledgment.mjs";
import { checkContactAcknowledgment } from "./contact-acknowledgment.mjs";
import { checkHomeModules } from "./home-modules.mjs";
import { checkHomeStudioDetails } from "./home-studio-details.mjs";
import { checkHomeReasons } from "./home-reasons.mjs";
import { checkDisputeReview } from "./dispute-review.mjs";
import { captureHomeStudio } from "./home-studio-capture.mjs";
import { checkSalesComparisons } from "./sales-comparisons.mjs";
import { checkPauseAcknowledgment } from "./pause-acknowledgment.mjs";
import { checkBillingStudioObservation } from "./billing-studio-observation.mjs";
import { checkClaimAcknowledgment } from "./claim-acknowledgment.mjs";
import { checkShipmentAcknowledgment } from "./shipment-acknowledgment.mjs";
import { checkDiscountAcknowledgment } from "./discount-acknowledgment.mjs";
import { checkButtonContrast } from "./button-contrast.mjs";
import { checkDetailsAcknowledgment } from "./details-acknowledgment.mjs";
import {checkEmailCapabilities} from "./email-capabilities.mjs";
import {checkRenameAcknowledgment} from "./rename-acknowledgment.mjs";
import {checkTaxSaveAcknowledgment} from "./tax-save-acknowledgment.mjs";
import {checkTaxScope} from "./tax-scope.mjs";
import {checkComposerAmericanEnglish} from "./us-english-composer.mjs";
import {checkBlockPickerTurnsWide} from "./block-picker-wide.mjs";
import {checkPublicAmericanEnglish,checkStudioAmericanEnglish} from "./public-us-english.mjs";
import {checkPathCertificates} from "./path-certificates.mjs";
/**
 * Copying a whole store into another of the account's stores
 * (docs/store-copy.md), in a real browser: the studio's link to it, the page,
 * its preview, the copy run step by step to "Done", and the page at 390 and
 * 1280 with no sideways scroll and nothing axe-core (this project's copy)
 * finds at WCAG 2.0, 2.1 and 2.2 A and AA. What the copy writes is checked
 * field by field in tests/store-copy.test.ts.
 *
 *   node tests/e2e/store-copy.mjs              builds the app, then checks
 *   node tests/e2e/store-copy.mjs --no-build   uses the build already in .next
 *
 * The real app against the stand-in database of tests/e2e/services.mjs, as
 * tests/e2e/agreements.mjs runs it; nothing real is reached. In CI it runs
 * after the production build of the "verify" job.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { startServices } from "./services.mjs";
import { fieldFocusPixels,mountFieldFocusFixture } from "./field-focus.mjs";
import { checkGrowthAndContact } from "./growth-contact.mjs";
import { checkPathReminder, checkPathAnswers } from "./path-reminder.mjs";
import { checkPathBoardReplies } from "./path-board-replies.mjs";
import {checkPathWording} from "./path-wording.mjs";
import {checkPathScripts} from "./path-scripts.mjs";
import {checkReturnPath} from "./path-return.mjs";
import {checkPostSalePath} from "./path-growth.mjs";
import { checkPathCardText } from "./path-card-text.mjs";
import { checkShrinkTone } from "./shrink-tone.mjs";

async function storePlaceholderContrast(page,field){
  return placeholderPaint(page,field);
}

async function checkSignInErrorContrast(page,selector,label){
  await page.addScriptTag({content:axeSource});
  const report=await page.evaluate(async selector=>{
    const node=document.querySelector(selector);
    if(!node||!node.textContent.trim()||!node.getClientRects().length)throw Error("Expected visible error copy");
    const result=await window.axe.run([node],{runOnly:{type:"rule",values:["color-contrast-enhanced"]}});
    return {passes:result.passes.filter(rule=>rule.id==="color-contrast-enhanced").reduce((n,rule)=>n+rule.nodes.length,0),violations:result.violations.map(rule=>rule.id),incomplete:result.incomplete.map(rule=>rule.id)};
  },selector);
  is(label+": enhanced contrast evaluated",report.passes>0,true);
  is(label+": no contrast violations",report.violations,[]);
  is(label+": no inconclusive contrast readings",report.incomplete,[]);
}

async function checkSecondaryTextContrast(page,label){
  await page.addScriptTag({content:axeSource});
  const reading=await page.evaluate(async()=>{
    const nodes=[...document.querySelectorAll(".text-ink-soft,.text-ink-mute,.field-hint")].filter(node=>node.children.length===0&&node.textContent.trim()&&node.getClientRects().length>0&&!node.closest('[aria-hidden="true"]'));
    if(!nodes.length)return {count:0,violations:[],incomplete:[],passes:0};
    const report=await window.axe.run(nodes,{runOnly:{type:"rule",values:["color-contrast-enhanced"]}});
    return {count:nodes.length,violations:report.violations.map(violation=>({id:violation.id,targets:violation.nodes.map(node=>node.target)})),incomplete:report.incomplete.map(rule=>({id:rule.id,targets:rule.nodes.map(node=>node.target)})),passes:report.passes.filter(rule=>rule.id==="color-contrast-enhanced").reduce((total,rule)=>total+rule.nodes.length,0)};
  });
  is(label+": actual leaf secondary text exists",reading.count>0,true);
  is(label+": contrast was actually evaluated",reading.passes>0,true);
  is(label+": selected secondary text passes enhanced contrast",reading.violations,[]);
  is(label+": no inconclusive secondary contrast readings",reading.incomplete,[]);
}

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../..");
const nextCli = join(root, "node_modules/next/dist/bin/next");
const SERVICES = Number(process.env.E2E_SERVICES_PORT || 4489);
const APP = Number(process.env.E2E_APP_PORT || 3189);
const LOCAL = `http://localhost:${APP}`;
const FAKE = `http://127.0.0.1:${SERVICES}`;
const BUILD = !process.argv.includes("--no-build");

const env = {
  ...process.env,
  DEMO_STUDIO_ADMIN: "operator@example.test",
  STRIPE_DEMO_ACCOUNT_ID: "acct_fixtureDemo",
  UPSTASH_REDIS_REST_URL: FAKE,
  UPSTASH_REDIS_REST_TOKEN: "local",
  RESEND_API_KEY: "re_local_only_a_stand_in",
  RESEND_API_BASE: FAKE,
  ANTHROPIC_API_KEY: "sk-ant-local_only_"+"x".repeat(30),
  ANTHROPIC_API_BASE: FAKE,
  STRIPE_DEMO_SECRET_KEY: "sk_test_local_only_a_stand_in",
  // listSales checks that platform selling is configured; every API call still uses FAKE.
  STRIPE_SECRET_KEY: "sk_test_local_only_a_stand_in_0000",
  STRIPE_CONNECT_API_BASE: FAKE,
  NEXT_FONT_GOOGLE_MOCKED_RESPONSES: join(here, "google-fonts-mock.cjs"),
  E2E_FONT_ORIGIN: FAKE,
  NEXT_TELEMETRY_DISABLED: "1",
};

const require = createRequire(join(root, "package.json"));
const engine = process.env.E2E_BROWSER ?? "chromium";
if (!["chromium", "firefox", "webkit"].includes(engine)) throw new Error(`Unsupported E2E_BROWSER: ${engine}`);
let browserType;
for (const name of ["playwright", "playwright-core", process.env.PLAYWRIGHT_CORE].filter(Boolean)) {
  try {
    browserType = require(name)[engine];
    break;
  } catch {}
}
if (!browserType) {
  console.error("This needs Playwright or playwright-core on the machine (PLAYWRIGHT_CORE=<its folder> to name one). Nothing was run.");
  process.exit(2);
}
const axeSource = readFileSync(require.resolve("axe-core/axe.min.js"), "utf8");

async function launch() {
  // Firefox/WebKit must fail visibly if unavailable; never substitute Chromium.
  if (engine !== "chromium") return browserType.launch();
  if (process.env.CHROMIUM) return browserType.launch({ executablePath: process.env.CHROMIUM });
  try {
    return await browserType.launch();
  } catch (first) {
    try {
      return await browserType.launch({ channel: "chrome" });
    } catch {
      throw first;
    }
  }
}

let failed = 0;
function is(name, got, want) {
  const same = JSON.stringify(got) === JSON.stringify(want);
  console.log(`  ${same ? "ok  " : "FAIL"}  ${name}`);
  if (!same) {
    failed += 1;
    console.log(`        expected ${JSON.stringify(want)}\n        got      ${JSON.stringify(got)}`);
  }
}

const services = await startServices(SERVICES);
let app = null;
let browser = null;
let appLog = "";
const run = (cmd, args) =>
  new Promise((done) => {
    const child = spawn(cmd, args, { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
    let said = "";
    child.stdout.on("data", (chunk) => (said += chunk));
    child.stderr.on("data", (chunk) => (said += chunk));
    child.on("close", (status) => done({ status, said }));
  });

try {
  const out = mkdtempSync(join(tmpdir(), "mm-copy-seed-"));
  const seedFile = join(out, "seed.cjs");
  await build({ entryPoints: [join(here, "store-copy-seed.ts")], bundle: true, platform: "node", format: "cjs", outfile: seedFile, logLevel: "error", alias: { "@": root } });
  // Not spawnSync: the stand-in database it writes to is served by this very process.
  const seeded = await run(process.execPath, [seedFile]);
  rmSync(out, { recursive: true, force: true });
  if (seeded.status !== 0) throw new Error(`the store could not be made:\n${seeded.said}`);
  const { guideFixture,billingObservation,certificateHeadingFixture,shippingFixture,libraryFixture,signinPrices,activationFixture,packageFixture,tierFixture,exitFixture,homeDemo,pauseFixtures,session, second, abProduct, abStore, contactToken,growthSession,growthSid,growthProduct,returnSession,returnSid,wordingSession,wordingSid,wordingTrialSession,wordingTrialSid } = JSON.parse(seeded.said.trim().split("\n").at(-1));

  if (BUILD) {
    const built = await run(process.execPath, [nextCli, "build"]);
    if (built.status !== 0) throw new Error(`the app did not build:\n${built.said.slice(-3000)}`);
  }
  app = spawn(process.execPath, [nextCli, "start", "-p", String(APP)], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32" });
  app.stdout.on("data", (chunk) => (appLog += chunk));
  app.stderr.on("data", (chunk) => (appLog += chunk));
  const started = Date.now();
  while (!(await fetch(`${LOCAL}/@signshop`).then((r) => r.status === 200).catch(() => false))) {
    if (Date.now() - started > 120_000) throw new Error(`the app did not start:\n${appLog.slice(-2000)}`);
    await new Promise((wait) => setTimeout(wait, 1000));
  }

  browser = await launch();
  // All helper contexts use intercepted synthetic APIs; workers must not bypass them.
  const createIsolatedContext = browser.newContext.bind(browser);
  browser.newContext = async (options = {}) => {
    const context = await createIsolatedContext({ ...options, serviceWorkers: "block" });
    await context.addInitScript(() => {
      window.__mmNavigationRsc = [];
      const original = window.fetch;
      window.fetch = async function (...args) {
        const input = args[0], url = new URL(typeof input === "string" || input instanceof URL ? input : input.url, location.href);
        const entry = url.origin === location.origin && url.searchParams.has("_rsc") ? {done:false} : null;
        if (entry) window.__mmNavigationRsc.push(entry);
        try {
          const response = await original.apply(this,args);
          if (entry) response.clone().text().then(() => {entry.done=true;},() => {entry.done=true;});
          return response;
        } catch(error) {if(entry)entry.done=true;throw error;}
      };
    });
    const newPage = context.newPage.bind(context);
    context.newPage = async (...args) => {
      const page = await newPage(...args);
      const settle = async () => {
        // A no-script document cannot start fetch/RSC work or RAF polling.
        // Keep the full drain for every JavaScript-enabled helper context.
        if(options.javaScriptEnabled===false || page.isClosed() || page.url()==="about:blank")return;
        await page.waitForFunction(()=>{
          if(window.__mmNavigationRsc?.some(entry=>!entry.done)){delete window.__mmRscIdleSince;return false;}
          window.__mmRscIdleSince??=performance.now();
          return performance.now()-window.__mmRscIdleSince>=200;
        },undefined,{timeout:60000});
        await page.evaluate(()=>{delete window.__mmRscIdleSince;});
      };
      const goto=page.goto.bind(page),reload=page.reload.bind(page),resize=page.setViewportSize.bind(page),close=page.close.bind(page);
      page.goto=async (...args)=>{await settle();return goto(...args);};
      page.reload=async (...args)=>{await settle();return reload(...args);};
      page.setViewportSize=async (...args)=>{await settle();const result=await resize(...args);await settle();return result;};
      page.close=async (...args)=>{await settle();return close(...args);};
      return page;
    };
    const closeContext=context.close.bind(context);
    context.close=async (...args)=>{
      for(const page of context.pages()){
        if(options.javaScriptEnabled===false||page.isClosed()||page.url()==="about:blank")continue;
        await page.waitForFunction(()=>{
          if(window.__mmNavigationRsc?.some(entry=>!entry.done)){delete window.__mmRscIdleSince;return false;}
          window.__mmRscIdleSince??=performance.now();
          return performance.now()-window.__mmRscIdleSince>=200;
        },undefined,{timeout:60000});
        await page.evaluate(()=>{delete window.__mmRscIdleSince;});
      }
      return closeContext(...args);
    };
    return context;
  };
  console.log(`BROWSER_ENGINE_REPORT:${JSON.stringify({ requested: engine, actual: browserType.name(), version: browser.version() })}`);
  const errors = [];
  const watch = (page) => page.on("pageerror", (error) => {console.error("WATCHED_PAGE_ERROR:"+JSON.stringify({url:page.url(),error:String(error),stack:error.stack}));errors.push(String(error));});
  const open = async (page, url) => { const response=await page.goto(url,{waitUntil:"networkidle",timeout:60000}); if(!new URL(url).pathname.startsWith("/@"))is("platform document declares American English",await page.locator("html").getAttribute("lang"),"en-US"); return response; };
  const studio = await browser.newContext({ serviceWorkers: "block", viewport: { width: 1280, height: 900 } });
  await studio.addCookies([{ name: "nl_session", value: session, url: LOCAL }]);
  const owner = await studio.newPage();
  watch(owner);
  await open(owner,LOCAL+"/studio?store="+second);
  const studioReminder=owner.locator('aside[aria-labelledby="path-studio-reminder-title"]');
  is("an owner sees the unvisited-day reminder",await studioReminder.isVisible(),true);
  is("reminder keeps the selected store",await studioReminder.getByRole("link",{name:"Open your Path",exact:true}).getAttribute("href"),"/studio/path?store="+second);
  for(const width of [390,1280]) {
    await owner.setViewportSize({width,height:900});
    await owner.addScriptTag({content:axeSource});
    is("studio Path reminder at "+width+": axe",await owner.evaluate(async()=>(await window.axe.run('aside[aria-labelledby="path-studio-reminder-title"]',{runOnly:{type:"tag",values:["wcag2a","wcag2aa","wcag21a","wcag21aa","wcag22a","wcag22aa"]}})).violations.map(v=>v.id)),[]);
    is("studio Path reminder at "+width+": fits",await studioReminder.evaluate(node=>node.scrollWidth<=node.clientWidth),true);
  }
  await studioReminder.getByRole("link",{name:"Open your Path",exact:true}).click();
  await owner.getByRole("heading",{name:"Your next mission",exact:true}).waitFor();
  await checkPathReminder({owner,LOCAL,sid:second,axeSource});
  await checkPathAnswers({owner,LOCAL,sid:second,axeSource});
  await open(owner,LOCAL+"/studio?store="+second);
  is("opening Path removes today's studio reminder",await owner.locator('aside[aria-labelledby="path-studio-reminder-title"]').count(),0);
  await open(owner, `${LOCAL}/studio`);
  is("the studio links to the copy", await owner.getByRole("link", { name: "Copy it into another store" }).count(), 1);
  await open(owner, `${LOCAL}/studio/copy`);
  is("the page names the other store", (await owner.locator("select option").allTextContents()).some(label=>label.includes("Second Coaching")), true);
  await owner.getByRole("button", { name: "See what it makes" }).click();
  await owner.waitForSelector("ul[aria-label] li");
  is("the preview says what it makes and what never comes across", [(await owner.locator("ul[aria-label]").innerText()).includes("Makes 3 products"), (await owner.locator("ul[aria-label]").innerText()).includes("Never copied: customers")], [true, true]);
  await owner.getByRole("button", { name: /Copy into/ }).click();
  await owner.waitForFunction(() => document.querySelector('main [role="status"]')?.textContent?.startsWith("Done."), null, { timeout: 60_000 });
  is("the copy runs to the end and says what it made", (await owner.locator('main [role="status"]').innerText()).startsWith("Done. Made in Second Coaching: 3 products"), true);
  // Campaign discovery must stay local; only choosing one starts a metered
  // server preview. Exercise its real import route with a form-only campaign.
  await open(owner, `${LOCAL}/studio/funnels`);
  let previews = 0;
  owner.on("request", (request) => {
    if (request.url().includes("/api/store/funnel-share") && request.method() === "POST") previews += 1;
  });
  await owner.getByLabel("What do you want to do?").selectOption("sales");
  await owner.getByLabel("Find a campaign").fill("digital toolkit");
  // Each journey button names its campaign for assistive technology after its visible words (#3799, WCAG 2.4.6).
  const journey = owner.getByRole("button", { name: /^See the journey and what you need\s*: \S/ });
  is("the one matching campaign's journey button names it", await journey.count(), 1);
  await journey.click();
  is("campaign requirements come from the actual bundle", await owner.getByText("Your download or toolkit (paid)", { exact: true }).isVisible(), true);
  is("the journey is keyboard accessible", await owner.getByRole("button", { name: /^Hide the journey\s*: \S/ }).getAttribute("aria-expanded"), "true");
  await owner.getByLabel("Find a campaign").fill("no-such-campaign");
  is("unmatched search can be reset", await owner.getByText("No campaigns match these filters.", { exact: true }).isVisible(), true);
  await owner.getByRole("button", { name: "Show all campaigns", exact: true }).click();
  is("browsing spends no server previews", previews, 0);
  await owner.getByRole("button", { name: "Set up this campaign: Build a launch waitlist", exact: true }).click();
  await owner.getByLabel("Name, for you", { exact: true }).waitFor();
  is("choosing a campaign starts one server preview", previews, 1);
  await owner.getByLabel("Name, for you", { exact: true }).fill("Browser waitlist campaign");
  await owner.getByRole("button", { name: "Bring it in as a draft", exact: true }).click();
  await owner.getByText("Made as a draft. It is in the list above, off, with its pages kept back.", { exact: true }).waitFor();
  // A success notice precedes router.refresh(). Read a fresh page to prove
  // persistence rather than racing the asynchronous refresh of the list.
  await owner.reload({ waitUntil: "networkidle" });
  const savedCampaign = owner.locator("#fs-funnel option").filter({ hasText: /^Browser waitlist campaign$/ });
  await savedCampaign.waitFor({ state: "attached" });
  is("a new waitlist campaign is saved by the real import", await savedCampaign.count(), 1);
  const nextCheck=owner.locator('details[aria-label="Suggested next funnel check"]').first();
  const nextSummary=nextCheck.locator("summary");
  await nextSummary.focus();
  await owner.keyboard.press("Enter");
  is("next funnel check opens with keyboard",await nextCheck.getAttribute("open"),"");
  is("next funnel check explains its limits",await nextCheck.getByText("Suggested order for manual checks, from saved configuration and approximate counts. This is not a forecast or an experiment result.",{exact:true}).isVisible(),true);
  const launchChecklist=owner.locator('details[aria-label="Saved funnel launch checklist"]').first();
  await launchChecklist.locator("summary").focus();
  await owner.keyboard.press("Enter");
  is("launch checklist opens with keyboard",await launchChecklist.getAttribute("open"),"");
  const checklistField=launchChecklist.getByRole("textbox");
  const checklistText=await checklistField.inputValue();
  is("checklist retains disabled saved configuration",checklistText.includes("The funnel address is disabled"),true);
  is("checklist never claims a performed checkout",checklistText.includes("not proof of a working checkout"),true);
  let checklistMutations=0;
  const watchChecklist=request=>{if(request.method()!=="GET"&&request.url().includes("/api/store/funnel"))checklistMutations++;};
  owner.on("request",watchChecklist);
  await owner.evaluate(()=>{
    window.__originalChecklistClipboard=navigator.clipboard;
    window.__copiedChecklist="";
    window.__refuseChecklistClipboard=false;
    Object.defineProperty(navigator,"clipboard",{configurable:true,value:{writeText:async text=>{
      if(window.__refuseChecklistClipboard)throw new Error("synthetic clipboard refusal");
      window.__copiedChecklist=text;
    }}});
  });
  const copyChecklist=launchChecklist.getByRole("button",{name:"Copy checklist",exact:true});
  await copyChecklist.focus();
  await owner.keyboard.press("Enter");
  await owner.locator(".nb-toast-text").filter({hasText:"Launch checklist copied. Review it before sharing."}).waitFor();
  is("clipboard success is announced once",await owner.getByRole("status").filter({hasText:"Launch checklist copied. Review it before sharing."}).count(),1);
  is("clipboard gets exactly the reviewed checklist",await owner.evaluate(()=>window.__copiedChecklist),checklistText);
  await owner.evaluate(()=>{window.__refuseChecklistClipboard=true;});
  await copyChecklist.click();
  await owner.locator(".nb-toast-text").filter({hasText:"Select the checklist text and copy it."}).waitFor();
  is("refused clipboard selects text for manual copy",await checklistField.evaluate(field=>document.activeElement===field&&field.selectionStart===0&&field.selectionEnd===field.value.length),true);
  is("clipboard refusal leaves readable selectable text",await checklistField.inputValue(),checklistText);
  is("copying the checklist never mutates a funnel",checklistMutations,0);
  owner.off("request",watchChecklist);
  await owner.evaluate(()=>Object.defineProperty(navigator,"clipboard",{configurable:true,value:window.__originalChecklistClipboard}));
  await open(owner, `${LOCAL}/studio/path`);
  await owner.getByRole("textbox", {name:"Your skills"}).fill("Baking");
  await owner.getByRole("textbox", {name:"Your subject"}).fill("Sourdough");
  await owner.getByRole("button", {name:"Start your Path",exact:true}).click();
  await owner.getByRole("heading", {name:"Your next mission",exact:true}).waitFor();
  is("Path explains live sales availability",await owner.getByRole("heading",{name:"Live sales are not available yet",exact:true}).isVisible(),true);
  is("Path explains its current payment coverage",await owner.getByText("Path currently verifies Stripe orders. PayPal sales do not update its sale mission or levels yet.",{exact:true}).isVisible(),true);
  is("Path records published store facts", await owner.getByRole("heading", {name:"First Light",exact:true}).count(), 1);
  is("Path never asks to check completion", await owner.locator('section[aria-labelledby="path-missions"] input[type="checkbox"], section[aria-labelledby="path-next"] input[type="checkbox"]').count(), 0);
  await owner.reload({waitUntil:"networkidle"});
  is("Path persists the answers", await owner.locator('input[name="subject"]').inputValue(), "Sourdough");
  await checkPathBoardReplies({owner,LOCAL,sid:second,axeSource,joined:false});
  const boardConsent=owner.getByLabel("Share my recorded mission count, a generated pseudonym and the reading time with other Path owners on the board.",{exact:true});
  is("board starts with unchecked explicit consent",await boardConsent.isChecked(),false);
  is("joining is disabled without consent",await owner.getByRole("button",{name:"Join the mission board",exact:true}).isDisabled(),true);
  is("API refuses missing board consent",await owner.evaluate(async()=>{const r=await fetch("/api/store/path",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({action:"board_join"})});return r.status;}),400);
  await boardConsent.check();
  await owner.getByRole("button",{name:"Join the mission board",exact:true}).click();
  await owner.getByRole("button",{name:"Leave the mission board",exact:true}).waitFor();
  await owner.getByRole("table",{name:"Recorded mission counts and their reading times"}).waitFor();
  is("board uses a generated alias",await owner.locator('section[aria-labelledby="path-board-title"]').getByText(/Creator [0-9a-f]{12}/).count()>0,true);
  await owner.reload({waitUntil:"networkidle"});
  is("board participation persists",await owner.getByRole("button",{name:"Leave the mission board",exact:true}).isVisible(),true);
  await checkPathBoardReplies({owner,LOCAL,sid:second,axeSource,joined:true});
  const postMission=owner.locator('section[aria-labelledby="path-missions"] > ul > li').filter({has:owner.getByRole("heading",{name:"Make 3 post links",exact:true})});
  is("partial post progress is shown",await postMission.getByText("0 of 3 recorded",{exact:true}).isVisible(),true);
  is("the progress meter has its verified count",await postMission.getByRole("progressbar").getAttribute("value"),"0");
  const stepToggle=postMission.locator("summary");
  await stepToggle.focus();
  await owner.keyboard.press("Enter");
  is("mission steps open with the keyboard",await postMission.locator("details").getAttribute("open"),"");
  is("the mission links to its own store",await postMission.getByRole("link",{name:"Share the store: posts",exact:true}).getAttribute("href"),"/studio?store="+(new URL(await owner.getByRole("link",{name:"Back to the studio",exact:true}).getAttribute("href"),LOCAL)).searchParams.get("store")+"#details");
  is("opening steps does not complete the mission",await postMission.getByText("Ready when you are",{exact:true}).isVisible(),true);
  await owner.keyboard.press("Enter");
  const campaignLink=owner.getByRole("link",{name:"Explore campaigns for this mission",exact:true});
  const campaignUrl=new URL(await campaignLink.getAttribute("href"),LOCAL);
  const beforeCampaignPreviews=previews;
  await campaignLink.click();
  await owner.getByLabel("What do you want to do?").waitFor();
  is("Path opens the sales campaign goal",await owner.getByLabel("What do you want to do?").inputValue(),"sales");
  is("campaign discovery keeps the Path store",new URL(owner.url()).searchParams.get("store"),campaignUrl.searchParams.get("store"));
  is("campaign discovery creates no preview",previews,beforeCampaignPreviews);
  await open(owner,LOCAL+campaignUrl.pathname+"?store="+campaignUrl.searchParams.get("store")+"&campaignGoal=leads#campaign-starters");
  is("lead campaigns can be opened directly",await owner.getByLabel("What do you want to do?").inputValue(),"leads");
  await open(owner,LOCAL+campaignUrl.pathname+"?store="+campaignUrl.searchParams.get("store")+"&campaignGoal=unknown#campaign-starters");
  is("invalid campaign goals fall back to all",await owner.getByLabel("What do you want to do?").inputValue(),"all");
  await open(owner,LOCAL+"/studio/path?store="+campaignUrl.searchParams.get("store"));
  await checkPathCardText({owner,axeSource});
  is("sales sharing starts switched off",await owner.getByLabel("Include sales kept after refunds",{exact:true}).isChecked(),false);
  await owner.getByRole("button",{name:"Send your current mission",exact:true}).click();
  await owner.waitForFunction(()=>Boolean(document.querySelector('section[aria-labelledby="path-reminder-title"] [role="status"]')?.textContent));
  is("a requested reminder has a visible result",await owner.locator('section[aria-labelledby="path-reminder-title"] [role="status"]').isVisible(),true);
  const cardDownload=owner.waitForEvent("download");
  await owner.getByRole("button",{name:"Download card",exact:true}).click();
  const card=await cardDownload;
  is("the owner can download their card",card.suggestedFilename(),"marktmorgen-path.svg");
  const cardStream=await card.createReadStream();
  if(!cardStream)throw new Error("The card download could not be read");
  let cardText="";
  for await(const chunk of cardStream)cardText+=chunk.toString();
  is("the default card keeps sales private",cardText.includes("Sales kept after refunds"),false);
  is("the card contains the reached level",cardText.includes("First Light"),true);
  await owner.getByLabel("Include sales kept after refunds",{exact:true}).check();
  is("sales enter the preview only after explicit choice",await owner.getByText("Sales kept after refunds: $0",{exact:true}).isVisible(),true);
  await owner.getByLabel("Include sales kept after refunds",{exact:true}).uncheck();
  for (const width of [390, 1280]) {
    const ctx = await browser.newContext({ serviceWorkers: "block", viewport: { width, height: 900 } });
    await ctx.addCookies([{ name: "nl_session", value: session, url: LOCAL }]);
    const page = await ctx.newPage();
    await open(page, `${LOCAL}/studio/copy`);
    await page.getByRole("button", { name: "See what it makes" }).click();
    await page.waitForSelector("ul[aria-label] li");
    is(`copy page at ${width}: no sideways scroll`, await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth), 0);
    await page.addScriptTag({ content: axeSource });
    is(`copy page at ${width}: axe`, await page.evaluate(async () => (await window.axe.run(document, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22a", "wcag22aa"] } })).violations.map((v) => v.id)), []);
    await open(page, `${LOCAL}/studio/funnels`);
    await page.getByLabel("Find a campaign").fill("launch waitlist");
    await page.getByRole("button", { name: /^See the journey and what you need\s*: \S/ }).click();
    const nextAtWidth=page.locator('details[aria-label="Suggested next funnel check"]').first();
    await nextAtWidth.locator("summary").click();
    // Stress a long unbroken customer title at the actual mobile and desktop widths.
    await nextAtWidth.locator("summary > span").evaluate(node=>{node.textContent="Next check: "+"LongTitle".repeat(20);});
    const checklistAtWidth=page.locator('details[aria-label="Saved funnel launch checklist"]').first();
    await checklistAtWidth.locator("summary").click();
    is("launch checklist text fits at "+width,await checklistAtWidth.getByRole("textbox").evaluate(node=>node.getBoundingClientRect().width<=node.parentElement.getBoundingClientRect().width),true);
    const sideways = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    await page.addScriptTag({ content: axeSource });
    const found = await page.evaluate(async () => (await window.axe.run(document, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22a", "wcag22aa"] } })).violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`));
    is(`campaign page at ${width}: no sideways scroll`, sideways, 0);
    is(`campaign page at ${width}: axe`, found, []);
    await checkSecondaryTextContrast(page,"Funnels at "+width);
    await open(page, `${LOCAL}/studio/path`);
    await page.locator('section[aria-labelledby="path-missions"] summary').first().click();
    await page.addScriptTag({content:axeSource});
    const pathViolations=await page.evaluate(async ()=>(await window.axe.run(document,{runOnly:{type:"tag",values:["wcag2a","wcag2aa","wcag21a","wcag21aa","wcag22a","wcag22aa"]}})).violations.map(v=>v.id));
    is(`Path at ${width}: axe`,pathViolations,[]);
    await checkSecondaryTextContrast(page,"Path at "+width);
    is(`Path at ${width}: no sideways scroll`,await page.evaluate(()=>document.documentElement.scrollWidth-document.documentElement.clientWidth),0);
    await ctx.close();
  }
  const abUrl=LOCAL+"/studio/pages?store="+abStore+"&product="+abProduct+"&test=headline";
  const unavailableText="Test counts are unavailable or inconsistent. No winner is selected from this reading. Use Refresh results to try again. Your unsaved page edits stay here.";
  for(const width of [390,1280]){
    await owner.setViewportSize({width,height:900});
    const unavailableReply=owner.waitForResponse(response=>response.url().includes("/api/store/ab?id="));
    await owner.goto(abUrl,{waitUntil:"domcontentloaded",timeout:60_000});
    is("malformed saved experiment reports HTTP503 at "+width,(await unavailableReply).status(),503);
    const unavailable=owner.getByText(unavailableText,{exact:true});
    await unavailable.waitFor();
    is("experiment failure is visible at "+width,await unavailable.isVisible(),true);
    is("experiment failure does not display a zero tally or winner at "+width,await owner.locator("[data-test-results]").count(),0);
    is("experiment warning fits at "+width,await unavailable.evaluate(node=>node.scrollWidth<=node.clientWidth),true);
    await owner.addScriptTag({content:axeSource});
    is("experiment warning accessibility at "+width,await owner.evaluate(async()=>(await window.axe.run("#headline-test",{runOnly:{type:"tag",values:["wcag2a","wcag2aa","wcag21a","wcag21aa","wcag22a","wcag22aa"]}})).violations.map(v=>v.id)),[]);
  }
  // Recovery uses a synthetic, coherent successful response; no payment is made.
  let allocation=0;
  let experimentAgeDays=30;
  let transientFailure=false;
  let holdReading=false;
  let releaseReading;
  let notifyHeldReading;
  let experimentRequests=0;
  await owner.route("**/api/store/ab?**",async route=>{
    experimentRequests++;
    if(holdReading)await new Promise(resolve=>{releaseReading=resolve;notifyHeldReading?.();});
    if(transientFailure)return route.fulfill({status:503,contentType:"application/json",body:JSON.stringify({ok:false,error:"unavailable"})});
    return route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({ok:true,currency:"usd",declared:null,shareB:allocation,counts:{va:1000,vb:1000,ca:30,cb:90,sa:30,sb:90,ra:30000,rb:90000,qa:30000000,qb:90000000,t0:Date.now()-experimentAgeDays*86400000}})});
  });
  await owner.goto(abUrl,{waitUntil:"domcontentloaded",timeout:60_000});
  await owner.getByText(unavailableText,{exact:true}).waitFor();
  is("invalid allocation is not silently replaced with an even split",await owner.locator("[data-test-results]").count(),0);
  allocation=0.5;
  await owner.goto(abUrl,{waitUntil:"domcontentloaded",timeout:60_000});
  await owner.locator("[data-test-results]").waitFor();
  await owner.getByText("The second headline wins. Your page now shows it to everybody. Make it the hero's own headline and switch the test off to keep it.",{exact:true}).waitFor();
  is("a coherent successful reading replaces the failure notice",await owner.getByText(unavailableText,{exact:true}).count(),0);
  const paymentBasisText="Gross buyer payments are measured here, including any tax collected at checkout. Refunds, disputes and payment fees are not deducted. This is not net revenue or profit.";
  for(const width of [390,1280]){
    await owner.setViewportSize({width,height:900});
    for(const age of [1,30]){
      experimentAgeDays=age;
      await owner.goto(abUrl,{waitUntil:"domcontentloaded",timeout:60_000});
      const basis=owner.getByText(paymentBasisText,{exact:true});
      await basis.waitFor();
      is("paid results disclose the actual measurement at "+width+" age "+age,await basis.isVisible(),true);
      is("gross payment basis fits at "+width+" age "+age,await basis.evaluate(node=>node.scrollWidth<=node.clientWidth),true);
      if(age===1)await owner.getByText("One version is ahead, but a test decided by gross payments waits until it has run 14 days. This waiting period does not deduct refunds from either version.",{exact:true}).waitFor();
      else await owner.getByText("The second headline wins. Your page now shows it to everybody. Make it the hero's own headline and switch the test off to keep it.",{exact:true}).waitFor();
      await owner.addScriptTag({content:axeSource});
      is("paid experiment result accessibility at "+width+" age "+age,await owner.evaluate(async()=>(await window.axe.run("#headline-test",{runOnly:{type:"tag",values:["wcag2a","wcag2aa","wcag21a","wcag21aa","wcag22a","wcag22aa"]}})).violations.map(v=>v.id)),[]);
    }
  }
  const secondHeadline=owner.getByLabel("Second headline",{exact:true});
  const originalHeadline=await secondHeadline.inputValue();
  let experimentWrites=0;
  const watchExperimentWrites=request=>{
    if(request.method()!=="GET" && request.url().includes("/api/store/page"))experimentWrites++;
  };
  owner.on("request",watchExperimentWrites);
  for(const width of [390,1280]){
    await owner.setViewportSize({width,height:900});
    const draftHeadline="Keep this unsaved headline "+width;
    await secondHeadline.fill(draftHeadline);
    const requestedBefore=experimentRequests;
    const urlBefore=owner.url();
    transientFailure=true;
    const refresh=owner.getByRole("button",{name:"Refresh results",exact:true});
    await refresh.click();
    await owner.getByText(unavailableText,{exact:true}).waitFor();
    is("failed manual refresh keeps draft at "+width,await secondHeadline.inputValue(),draftHeadline);
    is("one request for manual refresh at "+width,experimentRequests,requestedBefore+1);
    transientFailure=false;
    holdReading=true;
    const heldReading=new Promise(resolve=>{notifyHeldReading=resolve;});
    await refresh.click();
    await heldReading;
    await owner.getByText("Loading test counts…",{exact:true}).waitFor();
    const pendingRefresh=owner.getByRole("button",{name:"Refreshing results…",exact:true});
    is("refresh disabled while reading at "+width,await pendingRefresh.isDisabled(),true);
    is("old winner hidden during refresh at "+width,await owner.locator("[data-test-results]").count(),0);
    await pendingRefresh.evaluate(button=>button.click());
    if(!releaseReading)throw Error("Synthetic delayed experiment was not requested");
    holdReading=false;
    releaseReading();
    releaseReading=undefined;
    await owner.locator("[data-test-results]").waitFor();
    is("retry makes only one extra request at "+width,experimentRequests,requestedBefore+2);
    is("successful retry keeps draft at "+width,await secondHeadline.inputValue(),draftHeadline);
    is("refresh stays on the editor at "+width,owner.url(),urlBefore);
    is("refresh target is at least44 pixels at "+width,await refresh.evaluate(button=>button.getBoundingClientRect().height>=44),true);
    await refresh.focus();
    is("refresh remains keyboard reachable at "+width,await refresh.evaluate(button=>document.activeElement===button),true);
    await secondHeadline.fill(originalHeadline);
  }
  owner.off("request",watchExperimentWrites);
  is("refresh and retry never save the edited page",experimentWrites,0);
  await owner.unroute("**/api/store/ab?**");
  // Added programme coverage uses only the disposable local fixtures.
  for(const width of [320,768]){
    await owner.setViewportSize({width,height:900});
    for(const path of ["/studio/funnels","/studio/path"]){
      await owner.goto(LOCAL+path,{waitUntil:"domcontentloaded",timeout:60_000});
      await owner.locator("main").waitFor();
      await checkSecondaryTextContrast(owner,path+" at "+width);
      is(path+" at "+width+": no horizontal overflow",await owner.evaluate(()=>document.documentElement.scrollWidth-document.documentElement.clientWidth),0);
    }
  }
  // Compile the production palette function; do not duplicate theme colours.
  const paintDir=mkdtempSync(join(tmpdir(),"mm-field-paint-"));
  const paintFile=join(paintDir,"look.cjs");
  await build({entryPoints:[join(root,"lib/store-look.ts")],bundle:true,platform:"node",format:"cjs",outfile:paintFile,logLevel:"error"});
  const {lookStyle,THEMES,ACCENTS}=require(paintFile);
  rmSync(paintDir,{recursive:true,force:true});
  for(const width of [320,390,768,1280]){
    const guest=await browser.newContext({serviceWorkers:"block",viewport:{width,height:900}});
    try{
      const signin=await guest.newPage();
      signin.on("pageerror",error=>errors.push(String(error)));
      await signin.emulateMedia({reducedMotion:"reduce"});
      await signin.goto(LOCAL+"/signin",{waitUntil:"domcontentloaded",timeout:60_000});
      await signin.locator("#signin-email").waitFor();
      await checkSecondaryTextContrast(signin,"Sign-in at "+width);
      is("sign-in at "+width+": no horizontal overflow",await signin.evaluate(()=>document.documentElement.scrollWidth-document.documentElement.clientWidth),0);
      const signinHint=await placeholderPaint(signin,signin.locator("#signin-email"));
      console.log("SIGNIN_PLACEHOLDER_PAINT:"+JSON.stringify({width,...signinHint}));
      is("sign-in placeholder has readable colour and full opacity at "+width,signinHint.ratio>=7&&signinHint.corePixels>=8&&signinHint.opacity===1,true);
      const focus=await fieldFocusPixels(signin,signin.locator("#signin-email"));
      is("email keyboard focus at "+width+": opaque3px outline",focus.style==="solid"&&parseFloat(focus.width)>=3&&parseFloat(focus.offset)>=3,true);
      is("email keyboard focus at "+width+": rendered3:1 pixel area",focus.contrastingPixels>=focus.minimumArea,true);
      console.log("  focus pixels email "+width+": "+focus.contrastingPixels+" / minimum "+focus.minimumArea);
      const storePaint=lookStyle({theme:"night",accent:"#ffff00"});
      const storeTarget=await mountFieldFocusFixture(signin,{surface:storePaint["--st-bg"],kind:"input",className:"st-field",paint:storePaint});
      const storeFocus=await fieldFocusPixels(signin,storeTarget);
      is("store input focus at "+width+": rendered3:1 pixel area",storeFocus.contrastingPixels>=storeFocus.minimumArea,true);
      const storeHint=await storePlaceholderContrast(signin,storeTarget);
      for(const [kind,className] of [["button","btn st-btn"],["button","btn st-btn-ghost"],["a","st-social"]]){
        const target=await mountFieldFocusFixture(signin,{surface:storePaint["--st-bg"],kind,className,paint:storePaint});
        const reading=await fieldFocusPixels(signin,target);
        is("store action "+className+" at "+width+": rendered3:1 pixel area",reading.contrastingPixels>=reading.minimumArea,true);
      }
      is("store placeholder at "+width+": enhanced contrast",storeHint.shown&&storeHint.ratio>=7&&storeHint.corePixels>=8&&storeHint.opacity===1,true);

      if(width===390){
        for(const theme of THEMES){
          for(const accent of ACCENTS){
            const paint=lookStyle({theme:theme.id,accent:accent.hex});
            const target=await mountFieldFocusFixture(signin,{surface:paint["--st-bg"],kind:"input",className:"st-field",paint});
            const reading=await fieldFocusPixels(signin,target);
            is("store input "+theme.id+"/"+accent.label+": rendered3:1 pixel area",reading.contrastingPixels>=reading.minimumArea,true);
            const hint=await storePlaceholderContrast(signin,target);
            is("store placeholder "+theme.id+"/"+accent.label+": actually shown",hint.shown,true);
            is("store placeholder "+theme.id+"/"+accent.label+": enhanced contrast",hint.ratio>=7&&hint.corePixels>=8,true);
            is("store placeholder "+theme.id+"/"+accent.label+": opaque",hint.opacity,1);
            for(const [kind,className] of [["button","btn st-btn"],["button","btn st-btn-ghost"],["a","st-social"]]){
              const action=await mountFieldFocusFixture(signin,{surface:paint["--st-bg"],kind,className,paint});
              const focus=await fieldFocusPixels(signin,action);
              is("store action "+className+" "+theme.id+"/"+accent.label+": rendered3:1 pixel area",focus.contrastingPixels>=focus.minimumArea,true);
              if(className==="btn st-btn") await checkButtonContrast({page:signin,target:action,label:theme.id+"/"+accent.label,is});
            }

          }
          const paint=lookStyle({theme:theme.id,accent:"#ffff00"});
          for(const kind of ["select","textarea"]){
            const target=await mountFieldFocusFixture(signin,{surface:paint["--st-card"],kind,className:"st-field",paint});
            const reading=await fieldFocusPixels(signin,target);
            is("store "+kind+" "+theme.id+"/custom yellow card: rendered3:1 pixel area",reading.contrastingPixels>=reading.minimumArea,true);
            if(kind==="textarea"){
              await target.evaluate(node=>{node.readOnly=false;node.value="";node.placeholder="Write a question";});
              const hint=await storePlaceholderContrast(signin,target);
              is("store textarea placeholder "+theme.id+": visible enhanced contrast",hint.shown&&hint.ratio>=7&&hint.corePixels>=8&&hint.opacity===1,true);
              await target.fill("A synthetic question");
              is("typed textarea text replaces the example "+theme.id,await target.evaluate(node=>node.value==="A synthetic question"&&!node.matches(":placeholder-shown")),true);
            }

          }
        }
        const socialPaint=lookStyle({theme:"light",accent:"#ffff00"});
        const social=await mountFieldFocusFixture(signin,{surface:socialPaint["--st-bg"],kind:"a",className:"st-social",paint:socialPaint});
        const socialCurrent=await fieldFocusPixels(signin,social);
        is("custom yellow social focus: opaque rings pass",socialCurrent.contrastingPixels>=socialCurrent.minimumArea,true);
        const oldSocialStyle=await signin.addStyleTag({content:".st-social:focus-visible{outline:2px solid var(--st-accent)!important;outline-offset:2px!important;box-shadow:none!important}"});
        const socialOld=await fieldFocusPixels(signin,social);
        is("pixel guard rejects former custom-yellow social focus",socialOld.contrastingPixels<socialOld.minimumArea,true);
        await oldSocialStyle.evaluate(node=>node.remove());
        const socialRestored=await fieldFocusPixels(signin,social);
        is("restored social focus passes",socialRestored.contrastingPixels>=socialRestored.minimumArea,true);
        const oldHintTarget=await mountFieldFocusFixture(signin,{surface:storePaint["--st-bg"],kind:"input",className:"st-field",paint:storePaint});
        const oldHintStyle=await signin.addStyleTag({content:".st-field::placeholder{color:var(--st-muted)!important;opacity:.75!important}"});
        const oldHint=await storePlaceholderContrast(signin,oldHintTarget);
        console.log("PLACEHOLDER_NEGATIVE_CONTROL:"+JSON.stringify(oldHint));
        is("placeholder guard rejects former faded Night text",oldHint.shown&&oldHint.ratio<7,true);
        await oldHintStyle.evaluate(node=>node.remove());
        const oldStoreTarget=await mountFieldFocusFixture(signin,{surface:storePaint["--st-bg"],kind:"input",className:"st-field",paint:storePaint});
        const oldStoreStyle=await signin.addStyleTag({content:".st-field:focus-visible{outline:none!important;box-shadow:0 0 0 3px var(--st-accent-soft)!important}"});
        const oldStoreFocus=await fieldFocusPixels(signin,oldStoreTarget);
        is("store pixel guard rejects former suppressed outline",oldStoreFocus.contrastingPixels<oldStoreFocus.minimumArea,true);
        await oldStoreStyle.evaluate(node=>node.remove());
        for(const surface of ["#ffffff","#111827","#888888"]){
          for(const kind of ["input","select","textarea"]){
            const target=await mountFieldFocusFixture(signin,{surface,kind});
            const reading=await fieldFocusPixels(signin,target);
            is(kind+" focus on "+surface+": rendered3:1 pixel area",reading.contrastingPixels>=reading.minimumArea,true);
          }
          const invalid=await mountFieldFocusFixture(signin,{surface,kind:"input",invalid:true});
          const invalidReading=await fieldFocusPixels(signin,invalid);
          is("invalid field focus on "+surface+": visible paint area",invalidReading.contrastingPixels>=invalidReading.minimumArea,true);
          is("invalid field keeps its error border on "+surface,await invalid.evaluate(node=>getComputedStyle(node).borderTopColor==="rgb(194, 38, 31)"),true);
        }
        // Reproduce the former suppression only in the disposable fixture:
        // this pixel guard must reject its weak outside glow.
        const baselineTarget=await mountFieldFocusFixture(signin,{surface:"#ffffff",kind:"input"});
        const oldSuppression=await signin.addStyleTag({content:".field:focus-visible{outline:none!important;box-shadow:0 0 0 4px rgba(73,70,166,.16)!important}"});
        const baseline=await fieldFocusPixels(signin,baselineTarget);
        is("pixel guard rejects the former suppressed-outline style",baseline.contrastingPixels<baseline.minimumArea,true);
        await oldSuppression.evaluate(node=>node.remove());
        await signin.emulateMedia({forcedColors:"active",reducedMotion:"reduce"});
        console.log("FORCED_COLORS_ENVIRONMENT:"+JSON.stringify({requested:"active",actual:await signin.evaluate(()=>matchMedia("(forced-colors: active)").matches),supportsForcedColorAdjust:await signin.evaluate(()=>CSS.supports("forced-color-adjust","auto"))}));
        if(!await signin.evaluate(()=>CSS.supports("forced-color-adjust","auto")))console.log("FIELD_FOCUS_OPEN_GAP:"+JSON.stringify({engine:browser.browserType().name(),reason:"forced-color-adjust declaration unsupported; no auto computed-value claim. System outline, shadow and actual3:1 painted-area assertions remain required; real OS validation remains open."}));
        for(const [kind,className] of [["button","btn st-btn"],["button","btn st-btn-ghost"],["a","st-social"]]){
          const target=await mountFieldFocusFixture(signin,{surface:storePaint["--st-bg"],kind,className,paint:storePaint});
          const focus=await fieldFocusPixels(signin,target);
          is("store action "+className+" forced colours: system outline",focus.style==="solid"&&parseFloat(focus.width)>=3&&focus.shadow==="none"&&(focus.supportsForcedColorAdjust?focus.forcedColorAdjust==="auto":focus.forcedColorAdjust===""),true);
          is("store action "+className+" forced colours: rendered3:1 pixel area",focus.contrastingPixels>=focus.minimumArea,true);
        }
        for(const kind of ["input","select","textarea"]){
          const target=await mountFieldFocusFixture(signin,{surface:storePaint["--st-bg"],kind,className:"st-field",paint:storePaint});
          const reading=await fieldFocusPixels(signin,target);
          is("store "+kind+" forced colours: system outline",reading.style==="solid"&&parseFloat(reading.width)>=3&&reading.shadow==="none"&&(reading.supportsForcedColorAdjust?reading.forcedColorAdjust==="auto":reading.forcedColorAdjust===""),true);
          is("store "+kind+" forced colours: rendered3:1 pixel area",reading.contrastingPixels>=reading.minimumArea,true);
        }
        for(const kind of ["input","select","textarea"]){
          const target=await mountFieldFocusFixture(signin,{surface:"#ffffff",kind});
          const forced=await fieldFocusPixels(signin,target);
          is(kind+" forced-colours focus: system outline remains",forced.style==="solid"&&parseFloat(forced.width)>=3&&forced.shadow==="none"&&(forced.supportsForcedColorAdjust?forced.forcedColorAdjust==="auto":forced.forcedColorAdjust===""),true);
          is(kind+" forced-colours focus: rendered3:1 pixel area",forced.contrastingPixels>=forced.minimumArea,true);
        }
      }
      // Actual sign-in validation only. Even an unexpected auth request is
      // intercepted locally: this test cannot send a login message.
      await signin.evaluate(()=>document.querySelector("#field-focus-fixture")?.remove());
      await signin.emulateMedia({forcedColors:"none",reducedMotion:"reduce"});
      // Disposable samples use the actual built shared CSS, with no app
      // records or provider requests. This is component evidence, not every journey.
      await signin.evaluate(()=>{
        const root=document.createElement("section");
        root.id="success-contrast-fixture";
        root.style.cssText="position:relative;background:#fff;color:#111827;padding:16px";
        for(const [className,text] of [["tag tag-live","Live"],["notice notice-success","Your changes are saved."]]){
          const node=document.createElement("p");
          node.className=className;
          node.textContent=text;
          root.append(node);
        }
        document.body.append(root);
      });
      const successReading=selector=>signin.locator(selector).evaluate(node=>{
        const style=getComputedStyle(node);
        const rgb=value=>{
          const parts=value.match(/[0-9.]+/g)?.map(Number);
          if(!parts||parts.length<3||(parts[3]??1)!==1)throw Error("Success copy must have opaque measured colours");
          return parts.slice(0,3);
        };
        const luminance=values=>values.map(value=>value/255).map(value=>value<=.04045?value/12.92:((value+.055)/1.055)**2.4).reduce((total,value,index)=>total+value*[.2126,.7152,.0722][index],0);
        if(Number(style.opacity)!==1)throw Error("Success sample is unexpectedly faded");
        const text=luminance(rgb(style.color)),background=luminance(rgb(style.backgroundColor));
        return {color:style.color,ratio:(Math.max(text,background)+.05)/(Math.min(text,background)+.05)};
      });
      for(const selector of ["#success-contrast-fixture .tag-live","#success-contrast-fixture .notice-success"]){
        await signin.locator(selector).scrollIntoViewIfNeeded();
        is("painted success copy exceeds7:1 "+selector+" at "+width,(await successReading(selector)).ratio>=7,true);
        await checkSignInErrorContrast(signin,selector,"Shared success copy "+selector+" at "+width);
      }
      if(width===390){
        const legacy=await signin.addStyleTag({content:"#success-contrast-fixture .tag-live,#success-contrast-fixture .notice-success{color:var(--mint-deep)!important}"});
        // Wait for the browser's style/transition frame before sampling.
        await signin.waitForFunction(()=>[...document.querySelectorAll("#success-contrast-fixture .tag-live,#success-contrast-fixture .notice-success")].every(node=>getComputedStyle(node).color==="rgb(11, 106, 77)"));
        // Measure the same actual computed CSS guard in both directions.
        // A scoped axe result alone must not make the negative control pass.
        for(const selector of ["#success-contrast-fixture .tag-live","#success-contrast-fixture .notice-success"]){
          const reading=await successReading(selector);
          is("negative control applies the actual former text colour "+selector,reading.color,"rgb(11, 106, 77)");
          is("painted success contrast guard rejects former colour "+selector,reading.ratio<7,true);
          console.log("  former success contrast "+selector+": "+reading.ratio.toFixed(3));
        }
        await legacy.evaluate(node=>node.remove());
        await signin.waitForFunction(()=>[...document.querySelectorAll("#success-contrast-fixture .tag-live,#success-contrast-fixture .notice-success")].every(node=>getComputedStyle(node).color==="rgb(7, 85, 62)"));
        for(const selector of ["#success-contrast-fixture .tag-live","#success-contrast-fixture .notice-success"]){
          is("restored success copy exceeds7:1 "+selector,(await successReading(selector)).ratio>=7,true);
          await checkSignInErrorContrast(signin,selector,"Restored success copy "+selector);
        }
      }
      await signin.evaluate(()=>document.querySelector("#success-contrast-fixture").remove());
      await signin.locator("#signin-email").scrollIntoViewIfNeeded();
      let loginRequests=0;
      await signin.route("**/api/auth/request",async route=>{loginRequests++;await route.abort();});
      const backgroundAlerts=await signin.getByRole("alert").count();
      const email=signin.locator("#signin-email");
      const emailForm=email.locator("xpath=ancestor::form");
      await email.fill("missing-domain");
      await email.press("Tab");
      await signin.locator("#signin-hint").waitFor();
      is("invalid email hint describes its field at "+width,await email.getAttribute("aria-describedby"),"signin-hint");
      is("invalid email marked at "+width,await email.getAttribute("aria-invalid"),"true");
      await checkSignInErrorContrast(signin,"#signin-hint","Email hint at "+width);
      await signin.getByRole("button",{name:"Email me a link",exact:true}).click();
      await signin.locator("#signin-error").waitFor();
      is("submitted invalid email has one alert at "+width,await emailForm.getByRole("alert").count(),1);
      is("submit adds only one alert beyond page navigation at "+width,await signin.getByRole("alert").count(),backgroundAlerts+1);
      is("submitted error describes its field at "+width,await email.getAttribute("aria-describedby"),"signin-error");
      await checkSignInErrorContrast(signin,"#signin-error","Submitted email error at "+width);
      await email.fill("");
      await signin.getByRole("button",{name:"Email me a link",exact:true}).click();
      is("empty email has useful message at "+width,await signin.locator("#signin-error").innerText(),"Type your email first.");
      await checkSignInErrorContrast(signin,"#signin-error","Empty email error at "+width);
      await email.fill("synthetic@example.test");
      is("correction clears invalid state at "+width,await email.getAttribute("aria-invalid"),null);
      is("correction removes stale alerts at "+width,await emailForm.getByRole("alert").count(),0);
      is("correction restores baseline page alerts at "+width,await signin.getByRole("alert").count(),backgroundAlerts);
      is("invalid attempts never request login email at "+width,loginRequests,0);
      is("sign-in errors fit at "+width,await signin.evaluate(()=>document.documentElement.scrollWidth-document.documentElement.clientWidth),0);

    } finally {await guest.close();}
  }
  await checkGrowthAndContact({owner,LOCAL,abStore,second,contactToken,axeSource});
  const quotaDir=mkdtempSync(join(tmpdir(),"mm-path-quota-"));
  const quotaFile=join(quotaDir,"quota.cjs");
  await build({entryPoints:[join(here,"path-board-quota.ts")],bundle:true,platform:"node",format:"cjs",outfile:quotaFile,logLevel:"error",alias:{"@":root}});
  const exhausted=await run(process.execPath,[quotaFile]);
  rmSync(quotaDir,{recursive:true,force:true});
  if(exhausted.status!==0)throw new Error("synthetic quota setup failed: "+exhausted.said);
  const pathSid=campaignUrl.searchParams.get("store");
  await open(owner,LOCAL+"/studio/path/privacy?store="+pathSid);
  await owner.getByRole("heading",{name:"Path board privacy",exact:true}).waitFor();
  const privateFile=await owner.evaluate(async sid=>{const r=await fetch("/api/store/path?store="+sid);return {status:r.status,body:await r.json()};},pathSid);
  is("private Path downloads after monthly quota exhaustion",privateFile.status,200);
  is("private export includes the owner's answers",privateFile.body.path.answers.subject,"Sourdough");
  is("private export includes explicit participation",Boolean(privateFile.body.path.board?.token),true);
  is("internal revision is excluded",privateFile.body.path.revision,undefined);
  await owner.getByRole("button",{name:"Leave the mission board",exact:true}).click();
  await owner.getByText("You are not on the mission board.",{exact:true}).waitFor();
  const afterLeave=await owner.evaluate(async sid=>(await fetch("/api/store/path?store="+sid)).json(),pathSid);
  is("withdrawal preserves private Path answers",afterLeave.path.answers.subject,"Sourdough");
  is("withdrawal removes exported membership",afterLeave.path.board,null);
  await checkPostSalePath({browser,LOCAL,services,session:growthSession,sid:growthSid,product:growthProduct,axeSource,is});
  await checkReturnPath({browser,LOCAL,session:returnSession,sid:returnSid,otherSid:growthSid,axeSource,is});
  await checkPathScripts({browser,LOCAL,session:growthSession,sid:growthSid,axeSource,is});
  await checkPathWording({browser,LOCAL,services,session:wordingSession,sid:wordingSid,trialSession:wordingTrialSession,trialSid:wordingTrialSid,axeSource,is});
  await checkPathCertificates({browser,LOCAL,session:growthSession,sid:growthSid,otherSession:wordingSession,axeSource,is});
  if(publicStandardAx2Run())await checkCertificateHeading({browser,LOCAL,fixture:certificateHeadingFixture,axeSource,is});
  await checkPublicAmericanEnglish({browser,LOCAL,is});
  await checkSalesComparisons({browser,LOCAL,axeSource,is});
  await checkGuidePlacement({browser,LOCAL,fixture:guideFixture,axeSource,is});
  await checkHomePath({browser,LOCAL,axeSource,is});
  await checkContactAcknowledgment({browser,LOCAL,fixture:homeDemo,axeSource,is});
  await checkRecoveryAcknowledgment({browser,LOCAL,fixture:homeDemo,is});
  await checkSocialAcknowledgment({browser,LOCAL,fixture:homeDemo,axeSource,is});
  await checkJoinAcknowledgment({browser,LOCAL,fixture:homeDemo,axeSource,is});
  await checkIntroAcknowledgment({browser,LOCAL,fixture:homeDemo,axeSource,is});
  await checkTipsAcknowledgment({browser,LOCAL,fixture:homeDemo,axeSource,is});
  await checkPdfStampAcknowledgment({browser,LOCAL,fixture:{session:growthSession,sid:growthSid,product:growthProduct},is});
  await checkPdfPreviewAcknowledgment({browser,LOCAL,fixture:{session:growthSession,sid:growthSid,product:growthProduct},is});
  await checkFaqAcknowledgment({browser,LOCAL,fixture:homeDemo,is});
  await checkSitesAcknowledgment({browser,LOCAL,fixture:homeDemo,is});
  await checkLeaveAcknowledgment({browser,LOCAL,fixture:tierFixture,is});
  await checkPackageAcknowledgment({browser,LOCAL,fixture:packageFixture,is});
  await checkNumbersAcknowledgment({browser,LOCAL,fixture:tierFixture,is});
  await checkYearlyAcknowledgment({browser,LOCAL,fixture:tierFixture,is});
await checkDunningAcknowledgment({browser,LOCAL,fixture:tierFixture,is});
await checkTierAcknowledgment({browser,LOCAL,fixture:tierFixture,is});
await checkOrderAcknowledgment({browser,LOCAL,fixture:{session:growthSession,sid:growthSid},is});
await checkExitAcknowledgment({browser,LOCAL,fixture:exitFixture,is});
await checkCartAcknowledgment({browser,LOCAL,fixture:{session:growthSession,sid:growthSid},is});
await checkEnableAcknowledgment({browser,LOCAL,fixture:homeDemo,is});
await checkPairsAcknowledgment({browser,LOCAL,fixture:{session:growthSession,sid:growthSid,product:growthProduct},is});
await checkCollectionsAcknowledgment({browser,LOCAL,fixture:{session:growthSession,sid:growthSid},is});
await checkLayoutAcknowledgment({browser,LOCAL,fixture:{session:growthSession,sid:growthSid},is});
await checkLookAcknowledgment({browser,LOCAL,fixture:homeDemo,is});
await checkLanguageAcknowledgment({browser,LOCAL,fixture:homeDemo,is});
await checkThanksAcknowledgment({browser,LOCAL,fixture:{session:growthSession,sid:growthSid,product:growthProduct},is});
await checkNoCountAcknowledgment({browser,LOCAL,fixture:homeDemo,is});
await checkNudgeAcknowledgment({browser,LOCAL,fixture:pauseFixtures[0],is});
  await captureHomeStudio({browser,LOCAL,fixture:homeDemo,is});
  await checkOfferPlanning({browser,LOCAL,fixture:libraryFixture,axeSource,is});
  await checkPixelAttributionCenter({browser,LOCAL,fixture:libraryFixture,axeSource,is});
  await checkPartnerCopy({browser,LOCAL,axeSource,is});
  await checkPublicTrustDesign({browser,LOCAL,axeSource,is});
  await checkTemplateLibrary({browser,LOCAL,fixture:libraryFixture,axeSource,is});
  await checkEvergreenGuides({browser,LOCAL,is,axeSource});
  await checkSalesLevers({browser,LOCAL,fixture:activationFixture,axeSource,is});
  await checkPlatformProof({browser,LOCAL,is});
  await checkCreatorShowcase({browser,LOCAL,axeSource,is});
  await checkSigninTerms({browser,LOCAL,prices:signinPrices,axeSource,is});
  await checkStoreActivation({browser,LOCAL,fixture:activationFixture,axeSource,is});
  await checkHotmartComparison({browser,LOCAL,axeSource,is});
  await checkPricingValue({browser,LOCAL,axeSource,is});
  await checkCreatorJourney({browser,LOCAL,axeSource,is});
  await checkHomeHero({browser,LOCAL,axeSource,is});
  await checkHomeModules({browser,LOCAL,axeSource,is});
  await checkHomeStudioDetails({browser,LOCAL,axeSource,is});
  await checkHomeReasons({browser,LOCAL,axeSource,is});
  await checkDisputeReview({browser,LOCAL,fixture:homeDemo,axeSource,is});
  await checkStudioAmericanEnglish({browser,LOCAL,session:growthSession,sid:growthSid,is});
  await checkComposerAmericanEnglish({browser,LOCAL,session:growthSession,sid:growthSid,product:growthProduct,is});
  await checkBlockPickerTurnsWide({browser,LOCAL,session:growthSession,sid:growthSid,product:growthProduct,is});
  await checkTaxScope({browser,LOCAL,session:growthSession,sid:growthSid,is});
  await checkTaxSaveAcknowledgment({browser,LOCAL,session:growthSession,sid:growthSid,is});
  await checkRenameAcknowledgment({browser,LOCAL,session:growthSession,sid:growthSid,is});
  await checkDetailsAcknowledgment({browser,LOCAL,session:growthSession,sid:growthSid,is});
  await checkClaimAcknowledgment({browser,LOCAL,session:growthSession,sid:growthSid,is});
  await checkPauseAcknowledgment({browser,LOCAL,fixtures:pauseFixtures,is});
  await checkEmailCapabilities({browser,LOCAL,is});
  const shipment=services.seedShipment("templatelibraryfixture",libraryFixture.product);
  await checkShipmentAcknowledgment({browser,LOCAL,fixture:libraryFixture,shipment,is});
  await checkMenuMounting({browser,LOCAL,is});
  await checkPurchaseResend({browser,LOCAL,fixture:libraryFixture,shipment,axeSource,is});
  await checkShippingSave({browser,LOCAL,fixture:shippingFixture,is});
  await checkDiscountAcknowledgment({browser,LOCAL,fixture:libraryFixture,is});
  await checkBillingStudioObservation({browser,LOCAL,services,fixture:billingObservation,is});
  await checkShrinkTone({ browser, root, is });
  is("no page threw", errors, []);
} catch (error) {
  failed += 1;
  console.error(error);
  console.error(appLog.slice(-3000));
  if(browser){for(const context of browser.contexts())for(const page of context.pages()){if(page.url().includes("/studio/pages"))console.error("Experiment editor state:",await page.locator("body").innerText().then(text=>text.slice(-6000)).catch(()=>"unreadable"));}}
} finally {
  await browser?.close().catch(() => {});
  if (app?.pid && app.exitCode === null) {
    try {
      if (process.platform === "win32") app.kill("SIGTERM");
      else process.kill(-app.pid, "SIGTERM");
    } catch {}
  }
  await services.close().catch(() => {});
}
console.log(failed ? `\n${failed} failed` : "\nall passed");
process.exit(failed ? 1 : 0);
