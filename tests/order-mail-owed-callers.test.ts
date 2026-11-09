/**
 * Every order email that was sent with its answer thrown away now goes
 * through sendOrderMail (lib/order-mail-owed.ts), so a certain refusal is
 * owed and tried again, never dropped (the owner's EM1; Claude 5's email
 * audit of 9 November 2026, HIGH 2, whose proof listed these sites). The
 * PayPal receipt (lib/paypal-sales.ts) is #3387's (Claude 6), which keeps it
 * on its own delivery list; it is the one site left here, by name.
 */
import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { erasedCommand } from "@/lib/order-mail-owed";
import { suppressedCommand } from "@/lib/suppression";
import { done, is, part } from "./check";

const read = (file: string) => readFileSync(file, "utf8");

part("No order email in lib/ is sent with its answer thrown away");
const files = execSync("grep -rl 'by: \"order\"' lib", { encoding: "utf8" }).trim().split("\n");
const dropped: string[] = [];
for (const file of files) {
  read(file).split("\n").forEach((line, i) => {
    if (/^\s*await sendEmail\(\{ meter: \{ by: "order" \}/.test(line)) dropped.push(`${file}:${i + 1}`);
  });
}
is("only #3387's PayPal receipt is left (lib/paypal-sales.ts)", dropped.filter((site) => !site.startsWith("lib/paypal-sales.ts:")), []);

part("The six sites of the audit send through sendOrderMail");
const sites: [string, number][] = [
  ["lib/call-packages.ts", 1], // a package's booking link
  ["lib/calls.ts", 2], // a booked call's confirmation to the buyer, and to the host
  ["lib/licence-keys.ts", 1], // a key for a buyer who waited
  ["lib/gifts.ts", 2], // a gift to its recipient, and its receipt to the buyer
];
for (const [file, count] of sites) {
  const src = read(file);
  is(`${file}: imports it`, /import \{[^}]*\bsendOrderMail\b[^}]*\} from "@\/lib\/order-mail-owed";/.test(src), true);
  is(`${file}: sends ${count} order email${count === 1 ? "" : "s"} through it`, (src.match(/\bsendOrderMail\(/g) ?? []).length, count);
  is(`${file}: and none around it`, /sendEmail\(\{\s*meter: \{ by: "order" \}/.test(src), false);
}

part("Each has its own idempotency key, the same on every try");
const calls = read("lib/calls.ts");
is("a booked call's two confirmations are keyed by the checkout and its time, so a move's confirmation is its own", [calls.includes("idempotencyKey: `nimbus-call-booked:${session}:${start}`"), calls.includes("idempotencyKey: `nimbus-call-host:${session}:${start}`")], [true, true]);
is("the type insists on one (OrderMessage)", existsSync("lib/order-mail-owed.ts") && /idempotencyKey: string;/.test(read("lib/order-mail-owed.ts")), true);

part("A gift is given before its email; its email is owed, not lost");
const gifts = read("lib/gifts.ts");
is("the recipient's email and the buyer's receipt are owed when refused", (gifts.match(/sendOrderMail\(store, \{/g) ?? []).length, 2);

part("An owed email reads the store's erased prints as lib/suppression.ts writes them (pre-review M1)");
for (const [list, address] of [["list_1", "Buyer@Example.test "], [null, "a@example.test"], ["", "a@example.test"]] as const) {
  is(`the same read for ${list ?? "no list"}`, erasedCommand(list, address), suppressedCommand(list, address));
}

done();
