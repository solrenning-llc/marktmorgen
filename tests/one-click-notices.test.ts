/**
 * The emails Marktmorgen sends a creator about their store's numbers (the busy-day email, lib/stats-report.ts; the
 * alerts, lib/store-alerts.ts; the quiet-sales email, lib/quiet-sales.ts) offer a mail app's own unsubscribe in one
 * click (RFC 8058), as the creator's own emails do (lib/mail.ts render): List-Unsubscribe with
 * List-Unsubscribe-Post: List-Unsubscribe=One-Click, both pointing at the signed stop (app/api/store/weekly). Before,
 * they carried List-Unsubscribe alone, which Gmail and Yahoo do not offer as a one-click stop, and proxy.ts refused the
 * mail app's POST from its own site.
 *
 * Checked: each sender sets both headers on the same stop link; proxy.ts lets the one-click POST in from another site;
 * and that POST, with no form field but List-Unsubscribe=One-Click, stops the emails (app/api/store/weekly POST).
 */
import { readFileSync } from "node:fs";
import { NextRequest } from "next/server";
import { proxy } from "@/proxy";
import { POST as weeklyPost } from "@/app/api/store/weekly/route";
import { weeklyOff, weeklyToken } from "@/lib/stats-report";
import { claimHandle, storeForEmail } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const HOST = "marktmorgen.com";

async function main(): Promise<void> {
  redis.clear();
  part("Each notice offers the one-click stop on its own stop link");
  for (const file of ["lib/stats-report.ts", "lib/store-alerts.ts", "lib/quiet-sales.ts"]) {
    const src = readFileSync(file, "utf8");
    is(`${file}: List-Unsubscribe and List-Unsubscribe-Post together`, /"List-Unsubscribe": `<\$\{stopUrl\}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click"/.test(src), true);
    is(`${file}: never List-Unsubscribe alone`, /"List-Unsubscribe": `<\$\{stopUrl\}>` \}/.test(src), false);
  }

  part("The mail app's one-click POST passes the proxy from its own site");
  await claimHandle("notices@example.com", "noticeshop", "Notice Shop", "");
  const store = (await storeForEmail("notices@example.com"))!;
  const url = `https://${HOST}/api/store/weekly?h=${store.handle}&t=${encodeURIComponent(weeklyToken(store.handle))}`;
  const oneClick = () => new NextRequest(url, {
    method: "POST",
    headers: { host: HOST, origin: "https://mail.example.net", "sec-fetch-site": "cross-site", "content-type": "application/x-www-form-urlencoded", "content-length": "26" },
    body: "List-Unsubscribe=One-Click",
  });
  is("not refused", (await proxy(oneClick())).status !== 403, true);
  is("control: any other store write from another site is still refused", (await proxy(new NextRequest(`https://${HOST}/api/store/product`, { method: "POST", headers: { host: HOST, origin: "https://mail.example.net", "sec-fetch-site": "cross-site", "content-type": "application/x-www-form-urlencoded", "content-length": "2" }, body: "{}" }))).status, 403);

  part("That POST stops the emails");
  is("control: on before", await weeklyOff(store.handle), false);
  is("stopped", (await weeklyPost(oneClick())).status, 200);
  is("off after", await weeklyOff(store.handle), true);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
