/**
 * The name shown as an email's sender is never a disguise (Claude 7's outgoing-email audit and its security read,
 * 15 November 2026). A creator's sender name or store name that holds an address, a real domain, an encoded word, or
 * claims to be Marktmorgen, a payment or platform brand, or a mail system (postmaster, mailer-daemon), is not shown:
 * the From falls back to the store's name when that is safe, else to a safe stand-in, itself checked. What is checked is
 * the name as a reader sees it: after NFKC (full-width ＠ and ．), without invisible or direction characters, with
 * letters of two alphabets in one word refused, and "Marktmorgen" matched without spaces, dots, accents or 0-for-o.
 * Generic words a real business uses (support, help desk, customer service) and names with a dot that are not domains
 * ("Node.js", "Mr.Smith", "St. Louis") are kept.
 *
 * Checked on the From lines this unit owns: the creator's own email (lib/mail.ts fromLine), the membership switches
 * (lib/tier-switch.ts, lib/yearly-switch.ts), and every free file that names a store as the sender
 * (lib/affiliates.ts, lib/buyer-orders.ts and lib/returning-code.ts through it, lib/calls.ts, lib/imports.ts,
 * lib/letter-access.ts, lib/licence-keys.ts), whose one display-name function now goes through lib/sender-name.ts.
 */
import { readdirSync, readFileSync } from "node:fs";
import { fromLine } from "@/lib/mail";
import { safeSenderName, senderNameOk } from "@/lib/sender-name";
import { done, is, part } from "./check";

const base = { handle: "harborkitchen", name: "Harbor Kitchen", mail: { fromName: "Ana at Harbor Kitchen", address: "1 Main St, Portland, OR 97201" } } as never;
const shown = (line: string) => line.match(/^"([^"]*)"/)?.[1] ?? "";

part("A plain name is kept as it is");
is("the creator's own sender name", shown(fromLine(base)), "Ana at Harbor Kitchen");
for (const fine of [
  "Zoë & Co's Bakery", "St. Louis Bakery", "Dr. Ana Coaching", "Ana Co. Ltd", "Studio 5.0", "Node.js Weekly", "Vue.js Lessons",
  "Mr.Smith Woodwork", "Harbor Kitchen Support", "Help Desk Heroes", "Customer Service Academy", "Café Ñandú",
  "Wise Owl Tutoring", "Visa Consulting", "Apple Support Group", "Microsoft Excel Training", "Google Ads Masterclass",
  "Jo.Me", "Studio.Live", "Ricardo.Dev", "Support", "Billing", "Admin", "Chase Photography", "Learn With Ana",
  "Ana 👩\u200D💻 Studio", "کتاب\u200Cفروشی", "Studio \u200FRTL", "Анна Иванова", "Αθηνά Studio", "Ice Cream Lab",
]) {
  is(`"${fine}" is a name, kept`, safeSenderName(fine, "x"), fine.normalize("NFKC"));
}

part("A disguise is never the sender's name");
const DISGUISES: [string, string][] = [
  ["an address", "support@paypal.com"],
  ["a full-width at sign", "support＠paypal.com"],
  ["a domain", "paypal.com"],
  ["a full-width dot", "paypal．com"],
  ["an ideographic full stop", "paypal。com"],
  ["a domain in a sentence", "news from apple.com today"],
  ["Marktmorgen", "Marktmorgen"],
  ["Marktmorgen with a space", "Markt morgen"],
  ["Marktmorgen with dots", "M.a.r.k.t.m.o.r.g.e.n"],
  ["Marktmorgen with a zero", "Marktm0rgen"],
  ["Marktmorgen with an accent", "Märktmorgen"],
  ["Marktmorgen Support", "Marktmorgen Support"],
  ["Cyrillic letters in a word", "Pаypal"],
  ["a Greek omicron in a word", "Marktmοrgen"],
  ["a zero-width space", "Mark​tmorgen"],
  ["a right-to-left override", "‮moc.lapyap"],
  ["a soft hyphen", "Markt­morgen"],
  ["a payment brand", "PayPal Security"],
  ["a platform brand", "Apple ID"],
  ["a payment brand's billing", "Stripe Billing"],
  ["a mail system", "Postmaster"],
  ["a mail system", "Mailer-Daemon"],
  ["an encoded word", "=?UTF-8?B?UGF5UGFs?="],
  ["small capitals", "ᴍᴀʀᴋᴛᴍᴏʀɢᴇɴ"],
  ["a Latin alpha", "Mɑrktmorgen"],
  ["a whole word in Cyrillic", "Сһаѕе"],
  ["a whole word in Greek", "Μετα"],
  ["digits for letters", "M4rktm0rg3n"],
  ["a 5 for an s", "5tripe Billing"],
  ["a capital I for an l", "PayPaI"],
  ["rn for m", "Marktrnorgen"],
  ["one letter dropped", "Marktmorgn"],
  ["one letter added", "Marktmorrgen"],
  ["one letter changed", "Marktmorgan"],
  ["a brand one letter off", "Paypall Security"],
  ["a brand split by a space", "Pay Pal"],
  ["a bank", "Chase"],
  ["a bank in two words", "Wells Fargo"],
  ["a tax office", "IRS"],
  ["a delivery brand", "USPS Delivery"],
  ["a delivery brand", "FedEx"],
  ["a delivery brand", "DHL"],
  ["a delivery brand", "UPS"],
  ["a platform brand", "Meta"],
  ["a platform brand", "Facebook Security"],
  ["a platform brand", "Instagram"],
  ["a platform brand", "Netflix Billing"],
  ["an exchange", "Binance"],
  ["a scam title", "Security Alert"],
  ["a scam title", "Fraud Department"],
  ["a scam title", "Account Services"],
  ["a scam title", "Trust & Safety"],
  ["a scam title", "noreply"],
  ["a scam title", "Your Bank"],
  ["a link", "https://evil.example"],
  ["a www address", "www.harbor"],
  ["an IP address", "192.168.0.1"],
  ["an IPv6 address", "2001:db8::1"],
  ["a domain in capitals", "PAYPAL.COM"],
  ["a domain under a newer top-level domain", "refund.shop"],
];
for (const [label, bad] of DISGUISES) {
  is(`${label}: "${bad}" is not shown`, senderNameOk(bad), false);
  const line = fromLine({ ...(base as object), mail: { fromName: bad, address: "1 Main St" } } as never);
  is(`${label}: the From falls back to the store's name`, shown(line), "Harbor Kitchen");
}
is("a store name that is itself a disguise falls back to the store's address", shown(fromLine({ ...(base as object), name: "help@bank.com", mail: { fromName: "Marktmorgen", address: "1 Main St" } } as never)), "@harborkitchen");
is("the stand-in is checked too: a disguised one is never shown", safeSenderName("noreply@stripe.com", "Marktm0rgen"), "A store");
is("invisible and direction characters never reach the From", /[​-‍⁠﻿­‪-‮⁦-⁩]/.test(safeSenderName("Har​bor⁦ Kitchen", "x")), false);

part("Every From that names a store goes through the one helper");
for (const file of ["lib/tier-switch.ts", "lib/yearly-switch.ts"]) {
  is(`${file}: safeSenderName on the store's name`, /m\.fromName\(safeSenderName\(store\.name, `@\$\{store\.handle\}`\)\)/.test(readFileSync(file, "utf8")), true);
}
for (const file of ["lib/affiliates.ts", "lib/buyer-orders.ts", "lib/calls.ts", "lib/imports.ts", "lib/letter-access.ts", "lib/licence-keys.ts"]) {
  const src = readFileSync(file, "utf8");
  is(`${file}: its display name is safeSenderName`, /function displayName\(name: string\): string \{\n\s+return safeSenderName\(name, "A store"\);/.test(src), true);
  is(`${file}: no name cleaned on its own any more`, /replace\(\/\["\\\\<>\\r\\n\]\/g/.test(src), false);
}
part("Every From built in lib/ and app/ goes through the helper, but the reserved files named here");
// Files whose From is not yet filtered because another agent holds them (docs/reservations/); taken to Claude 1.
const RESERVED = new Set(["lib/api-write.ts", "lib/community-access.ts", "lib/free.ts", "lib/inbound-mail.ts", "lib/learn.ts", "lib/membership-manage.ts", "lib/purchase-email.ts", "lib/store-join.ts", "lib/waitlist.ts"]);
const FROM_LINE = /`"\$\{[^`]*" <\$\{/;
const checked: string[] = [];
for (const dir of ["lib", "app"]) {
  for (const file of readdirSync(dir, { recursive: true }).map(String).filter((f) => /\.tsx?$/.test(f)).map((f) => `${dir}/${f}`)) {
    const src = readFileSync(file, "utf8");
    if (!FROM_LINE.test(src) || RESERVED.has(file)) continue;
    checked.push(file);
    const lines = src.split("\n").filter((l) => FROM_LINE.test(l));
    const helper = /function displayName\(name: string\): string \{\n\s+return safeSenderName\(/.test(src) || /import \{[^}]*\bdisplayName\b[^}]*\} from "@\/lib\/buyer-orders"/.test(src);
    is(`${file}: each From names the store through the helper`, lines.every((l) => /safeSenderName\(|displayName\(/.test(l)) && (helper || lines.every((l) => /safeSenderName\(/.test(l))), true);
  }
}
is("the files checked, every one not reserved", checked.sort(), ["lib/affiliates.ts", "lib/buyer-orders.ts", "lib/calls.ts", "lib/imports.ts", "lib/letter-access.ts", "lib/licence-keys.ts", "lib/mail.ts", "lib/returning-code.ts", "lib/withdrawal.ts"]);
done();
