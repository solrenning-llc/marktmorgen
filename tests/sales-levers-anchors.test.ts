// Each "Review … settings" link in the studio's "Grow your sales" card must land on a section that exists.
// "#recovery" named no element (VR site sweep, 12/11/2026): the link did nothing. The section is #checkout-reminders.
import assert from "node:assert/strict";
import test from "node:test";
import {readFileSync,readdirSync} from "node:fs";
import {join} from "node:path";
import {salesLeverSettings} from "@/lib/sales-levers";
import {claimHandle,storeForEmail} from "@/lib/store";
import {store as redis} from "./redis-stub";

/** Every literal id="…" in the studio page and the components it draws. */
function studioIds():Set<string>{
 const files=["app/studio/page.tsx",...readdirSync("components").filter(f=>f.endsWith(".tsx")).map(f=>join("components",f))];
 const ids=new Set<string>();
 for(const file of files)for(const m of readFileSync(file,"utf8").matchAll(/\bid="([A-Za-z][\w-]*)"/g))ids.add(m[1]);
 return ids;
}

test("every in-page lever link names a section the studio draws",async()=>{
 redis.clear();
 await claimHandle("levers-anchors@example.test","leversanchors","Synthetic shop","");
 const store=(await storeForEmail("levers-anchors@example.test"))!;
 const ids=studioIds();
 const anchors=salesLeverSettings(store).filter(lever=>lever.path.startsWith("#"));
 assert.ok(anchors.length>0);
 for(const lever of anchors)assert.ok(ids.has(lever.path.slice(1)),`${lever.title} links to ${lever.path}, which no studio section has`);
 assert.equal(salesLeverSettings(store).find(lever=>lever.key==="recovery")?.path,"#checkout-reminders");
 assert.ok(readFileSync("components/recovery-editor.tsx","utf8").includes('<section id="checkout-reminders"'));
});
