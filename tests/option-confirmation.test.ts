import { done, is, part } from "./check";
import { readFileSync } from "node:fs";
import { confirmsOptionWrite, OPTION_NOT_CONFIRMED, optionRefusalWords } from "@/lib/option-confirmation";
import { STUDIO_MESSAGES } from "@/lib/studio-messages";
part("Price changes need an explicit successful acknowledgment");
for (const raw of [null, [], {}, {ok:"true"}, {ok:1}, {ok:false},
  {ok:true,error:"server_error"}, {ok:true,error:null}, Object.create({ok:true})]) {
  is("an uncertain response cannot confirm a price write", confirmsOptionWrite(raw,true),false);
}
is("HTTP errors cannot confirm even with a success body",confirmsOptionWrite({ok:true},false),false);
is("the route's exact acknowledgment confirms",confirmsOptionWrite({ok:true},true),true);
part("A refused price change says why, when the studio can name it");
is("a session let in without its second step hears that it is locked, not that nothing was confirmed", optionRefusalWords("locked", {}), STUDIO_MESSAGES.locked);
is("a role refusal says so too", optionRefusalWords("role", {}), STUDIO_MESSAGES.role);
is("the block's own words come first", optionRefusalWords("store_full", { store_full: "Own words." }), "Own words.");
is("no reason, an unknown one or an inherited name is not confirmed", [null, "server_error", "toString", "__proto__"].map((r) => optionRefusalWords(r, {})), [OPTION_NOT_CONFIRMED, OPTION_NOT_CONFIRMED, OPTION_NOT_CONFIRMED, OPTION_NOT_CONFIRMED]);
const editor = readFileSync("components/product-editor.tsx", "utf8");
is("the options block words its refusals through optionRefusalWords with its own messages", /optionRefusalWords\(reason, OPTION_MESSAGES\)/.test(editor), true);
is("and nowhere types the not-confirmed sentence itself", editor.includes("The price change was not confirmed"), false);
done();
