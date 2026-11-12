/**
 * The challenge script is preloaded at the very address the installed botid asks for on its first load
 * (lib/browser-check-client.ts, challengeScriptUrl; #3642 option 1, v2). A preload is used only by a request for the
 * same address: one that differs is fetched twice, and a short visit's count is lost again (the tab closed 500 ms
 * after load, tests/e2e/store-beacon-short-visit.mjs). This reads botid's own code, so an upgrade that changes the
 * address fails here, not in production.
 */
import { readFileSync } from "node:fs";
import { CHALLENGE_SCRIPT, challengeScriptUrl } from "@/lib/browser-check-client";
import { done, is } from "./check";

const core = readFileSync("node_modules/botid/dist/client/core/index.js", "utf8");

is("botid loads its script from this path", core.includes(`"${CHALLENGE_SCRIPT}"`), true);
is("its first try is i=0", /#n=0[;,]/.test(core) && core.includes('searchParams.set("i",String(this.#n))'), true);
is("its protocol is v=3", core.includes('searchParams.set("v",String(3))'), true);
is("and it names the page's host", core.includes('searchParams.set("h",window.location.host)'), true);
is("in that order, as path plus search", /searchParams\.set\("h",window\.location\.host\),\w+\(\w+\.pathname\+\w+\.search\)/.test(core), true);

// The address as botid builds it, with URLSearchParams, for a host with a port.
const built = new URL(CHALLENGE_SCRIPT, "https://shop.example.test:8443");
built.searchParams.set("i", "0");
built.searchParams.set("v", "3");
built.searchParams.set("h", "shop.example.test:8443");
is("the preload asks for the very same address", challengeScriptUrl("shop.example.test:8443"), built.pathname + built.search);
is("and for a host without a port", challengeScriptUrl("marktmorgen.com"), `${CHALLENGE_SCRIPT}?i=0&v=3&h=marktmorgen.com`);

done();
