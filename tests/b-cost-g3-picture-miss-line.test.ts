/**
 * Rule MR audit, G3 (MÉDIO, kept without a PR): a picture or store photo whose address is not in the CDN (a made-up
 * name, a deleted one, or the first read in a region) is a function call plus a file-store get (product pictures,
 * up to 1 MB) or a Redis GET (store photos, up to 200 KB), paced only in memory per instance (lib/picture-pace.ts).
 * The registry called what passes "the CDN's picture of line visits", which a miss is not. A Redis-backed ceiling
 * would cost more per request than the read it bounds, so the honest state is a line that says the miss is not
 * priced: not certified, never zero. A firewall rate rule on the two routes is the owner's to decide.
 */
import { NOT_A_COST } from "./plan-cost-registry";
import { done, is, part } from "./check";

part("What a picture the CDN does not hold costs");
const line = String((NOT_A_COST as Record<string, string>).PICTURES_PER_MINUTE ?? "");
is("the note no longer says everything it lets through is the CDN's", /what it lets through is the CDN's/.test(line), false);
is("it names the function call and the read a miss makes", /function/.test(line) && /file store/.test(line) && /Redis GET/.test(line), true);
is("and says that cost is not certified, never zero", /not certified, never zero/.test(line), true);
done();
