/** Independent substitution/URL evidence; no network or inbox assertion. */
import { accessWords } from "@/lib/buyer-words/access";
import { LANGUAGE_CODES } from "@/lib/store-language";
import { done, is } from "./check";
let requests = 0;
globalThis.fetch = (async () => { requests++; throw Error("No provider request allowed"); }) as typeof fetch;
const url = "https://example.test/synthetic/orders?view=files%20only#access";
const email = "reader+access@example.test", store = "Synthetic Reader Studio";
for (const language of LANGUAGE_CODES) {
  const text = accessWords(language).openOrders(url, email, store);
  const links = text.match(/https:\/\/\S+/g) ?? [];
  is(`${language}: one complete URL with the supplied origin/path/query/fragment`, links.map(value => new URL(value).href), [new URL(url).href]);
  is(`${language}: the actual buyer address survives once`, text.match(/[A-Za-z0-9+._-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g), [email]);
  is(`${language}: store is substituted once`, text.split(store).length - 1, 1);
  is(`${language}: template interpolation has no transport side effect`, requests, 0);
}
is("unknown-language substitution matches English", accessWords("unknown").openOrders(url, email, store), accessWords("en").openOrders(url, email, store));
done();
