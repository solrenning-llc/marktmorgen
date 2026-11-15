/**
 * The help center's "How does Marktmorgen compare with Stan?" (lib/home-faq.ts
 * stanComparison, shown by lib/help-content.ts) lists what we have in place of
 * what Stan has. Zoom links are offered to every store only once Zoom approves
 * the app (ZOOM_APPROVED, lib/meet-providers.ts offeredProviders): until then
 * an ordinary creator's studio is offered Google only, and the answer must not
 * list Zoom links as something we have (audit R33, finding 2).
 *
 * Synthetic env only; no provider is reached.
 */
import { HELP_SECTIONS } from "@/lib/help-content";
import { STAN_QUESTION, stanComparison } from "@/lib/home-faq";
import { ZOOM_APPROVED, configuredProviders, offeredProviders } from "@/lib/meet-providers";
import { done, is, part } from "./check";

process.env.ZOOM_CLIENT_ID = "synthetic_zoom_client";
process.env.ZOOM_CLIENT_SECRET = "synthetic_zoom_secret";
process.env.ZOOM_WEBHOOK_SECRET_TOKEN = "synthetic_zoom_token";
process.env.GOOGLE_OAUTH_CLIENT_ID = "synthetic_google_client";
process.env.GOOGLE_OAUTH_CLIENT_SECRET = "synthetic_google_secret";
delete process.env.ZOOM_LIVE;

function main(): void {
  const items = HELP_SECTIONS.flatMap((s) => s.items);
  const stan = items.find((i) => i.q === STAN_QUESTION);
  const answer = (stan?.a ?? []).join(" ");

  part("Control: both providers configured; Zoom offered to every store only once approved");
  is("both providers are configured in this synthetic deployment", configuredProviders(), ["google", "zoom"]);
  const offered = offeredProviders({ sid: "0123456789abcdef0123456789abcdef", email: "creator@example.com" });
  is("an ordinary creator's studio is offered Zoom only when ZOOM_APPROVED", offered, ZOOM_APPROVED ? ["google", "zoom"] : ["google"]);
  is("the help center's Stan answer is found", Boolean(stan), true);
  is("it is the shared stanComparison text", answer, stanComparison());

  part("The Stan answer lists Zoom links only when every store is offered them");
  is("Zoom links among what we have", /What we have in their place:[^.]*Zoom links/.test(answer), ZOOM_APPROVED);
  is("Google Meet links are still listed", /What we have in their place:[^.]*Google Meet (and Zoom )?links/.test(answer), true);
  is("with PayPal available, the same rule holds", /What we have in their place:[^.]*Zoom links/.test(stanComparison(true)), ZOOM_APPROVED);
}

main();
done();
