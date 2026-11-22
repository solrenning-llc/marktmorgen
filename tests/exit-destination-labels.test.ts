/**
 * Codex G's two LEVEs on #3645, NOT FIXED in Codex X6's re-checks (20/11 and 21/11), lib/exit-redirect-rules.ts
 * exitDestination:
 *   1. A malformed DNS name (an empty label, a label that begins or ends with a hyphen, a label over 63 characters)
 *      is refused as not public.
 *   2. A trailing-dot host is checked through its bare form and returned and stored in that bare form, so the same
 *      address is one value.
 * Pure rules, no network.
 */
import { exitDestination } from "@/lib/exit-redirect-rules";
import { done, is, part } from "./check";

part("1. Malformed DNS names are refused");
for (const [what, address] of [
  ["an empty label", "https://a..b.com/"],
  ["a label that begins with a hyphen", "https://-a.com/"],
  ["a label that ends with a hyphen", "https://a-.example.com/"],
  ["a label over 63 characters", `https://${"a".repeat(64)}.com/`],
] as const) {
  const got = exitDestination(address);
  is(`${what}: refused as not public`, got.ok ? "accepted" : got.reason, "not_public");
}
for (const [what, address] of [
  ["control: a plain name", "https://shop.example.com/"],
  ["control: a hyphen inside a label", "https://my-shop.example.com/"],
  ["control: a punycode name", "https://xn--bcher-kva.com/"],
  ["control: a label of 63 characters", `https://${"a".repeat(63)}.com/`],
] as const) {
  is(what, exitDestination(address).ok, true);
}

part("2. A trailing-dot host is one value, its bare form");
const dotted = exitDestination("https://shop.example.com./home");
is("accepted", dotted.ok, true);
is("the host is stored bare", dotted.ok && dotted.host, "shop.example.com");
is("the address is stored bare", dotted.ok && dotted.url, "https://shop.example.com/home");
const plain = exitDestination("https://shop.example.com/home");
is("the same as the address typed without the dot", [dotted.ok && dotted.url, dotted.ok && dotted.host], [plain.ok && plain.url, plain.ok && plain.host]);
done();
