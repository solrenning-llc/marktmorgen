import { chromium } from "/home/user/marktmorgen/node_modules/playwright-core/index.mjs";
const b = await chromium.launch({ executablePath: process.argv[3] });
const pg = await b.newPage({ viewport: { width: 1280, height: 800 } });
await pg.goto("file://" + process.argv[2]);
const r = await pg.evaluate(() => {
  const box = (id) => document.getElementById(id).getBoundingClientRect();
  const c = (x) => Math.round(x.left + x.width / 2);
  const range = document.createRange(); range.selectNodeContents(document.getElementById("until"));
  const text = range.getBoundingClientRect();
  return { countdownCentre: c(box("cd")), unitsCentre: c(box("units")), untilTextCentre: c(text),
           bundleListRight: Math.round(box("bundle").right), itemRight: Math.round(box("item").right), priceRight: Math.round(box("price").right) };
});
console.log(JSON.stringify(r));
const bad = Math.abs(r.untilTextCentre - r.unitsCentre) > 4 || r.priceRight < r.bundleListRight - 4;
console.log(bad ? "FAIL: countdown line off-centre and/or bundle price not at the list's right edge" : "PASS");
await b.close(); process.exit(bad ? 1 : 0);
