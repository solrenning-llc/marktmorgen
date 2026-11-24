/**
 * Claude 5 id8Ws's LEVE on #5476 (7116800145): the notice after a disconnect whose grant was kept (MEET_ACCESS_SHARED,
 * shown in the studio and the email) said the other connection was "another of your stores", but the account's index
 * counts any store or team host connected with that provider account, whoever owns it (an agency's or an assistant's
 * account). The words say only what the code checked: another store or a team calendar on Marktmorgen, never whose.
 *
 * Text only: no store, request or provider is touched.
 */
import { MEET_ACCESS_SHARED } from "@/lib/call-setup";
import { done, is } from "./check";

for (const provider of ["google", "zoom"] as const) {
  const words = `${MEET_ACCESS_SHARED[provider].lead} ${MEET_ACCESS_SHARED[provider].rest}`;
  is(`${provider}: the notice never says the other store is the creator's own`, /\bof your\b/i.test(words), false);
  is(`${provider}: it says another store on Marktmorgen still uses the account`, /\bAnother store\b/.test(words), true);
}
is("google: it also names a team calendar", /team calendar/.test(MEET_ACCESS_SHARED.google.rest), true);

done();
