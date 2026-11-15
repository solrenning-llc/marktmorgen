/**
 * The name shown as an email's sender is never a disguise (Claude 7's outgoing-email audit, 15 November 2026): a
 * creator's sender name or store name that holds an address ("support@paypal.com"), a domain ("paypal.com") or
 * claims to be Marktmorgen or its support is not shown as the sender. The From line falls back to the store's name when
 * that is safe, else to the store's address (@handle), so the email still says whose it is. Checked on the three From
 * lines this unit owns: a creator's own email (lib/mail.ts fromLine) and the membership switch emails
 * (lib/tier-switch.ts, lib/yearly-switch.ts, through lib/sender-name.ts).
 */
import { readFileSync } from "node:fs";
import { fromLine } from "@/lib/mail";
import { safeSenderName } from "@/lib/sender-name";
import { done, is, part } from "./check";

const base = { handle: "harborkitchen", name: "Harbor Kitchen", mail: { fromName: "Ana at Harbor Kitchen", address: "1 Main St, Portland, OR 97201" } } as never;
const shown = (line: string) => line.match(/^"([^"]*)"/)?.[1] ?? "";

part("A plain name is kept as it is");
is("the creator's own sender name", shown(fromLine(base)), "Ana at Harbor Kitchen");
is("an apostrophe, an ampersand and accents stay", safeSenderName("Zoë & Co's Bakery", "x"), "Zoë & Co's Bakery");
for (const fine of ["St. Louis Bakery", "Dr. Ana Coaching", "Ana Co. Ltd", "Studio 5.0"]) is(`"${fine}" is a name, not a domain`, safeSenderName(fine, "x"), fine);

part("A disguise is never the sender's name");
for (const bad of ["support@paypal.com", "PayPal.com", "paypal.com security", "Marktmorgen", "Marktmorgen Support", "Support", "Billing Support Team", "www.apple.com"]) {
  const line = fromLine({ ...(base as object), mail: { fromName: bad, address: "1 Main St" } } as never);
  is(`"${bad}" falls back to the store's name`, shown(line), "Harbor Kitchen");
}
is("a store name that is itself a disguise falls back to the store's address", shown(fromLine({ ...(base as object), name: "help@bank.com", mail: { fromName: "Marktmorgen", address: "1 Main St" } } as never)), "@harborkitchen");
is("the helper's fallback is used as given", safeSenderName("noreply@stripe.com", "@harborkitchen"), "@harborkitchen");

part("The membership switch emails go through the same helper");
for (const file of ["lib/tier-switch.ts", "lib/yearly-switch.ts"]) {
  const src = readFileSync(file, "utf8");
  is(`${file}: the store's name is made safe by safeSenderName`, /m\.fromName\(safeSenderName\(store\.name, `@\$\{store\.handle\}`\)\)/.test(src), true);
}
done();
