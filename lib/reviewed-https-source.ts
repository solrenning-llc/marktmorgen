/**
 * The address of a page a reviewer read a tax figure on: the source of a reviewed VAT currency-conversion allowance
 * (lib/eu-vat-collection-cost.ts) and of each HMRC period-rate row (lib/hmrc-period-rates.ts). One rule for both, so
 * the two checks cannot drift apart again (Claude 1's NIT on #5334, 7098388657).
 *
 * A source counts only when it is written as "https://" and then a domain name, exactly as the page's own address:
 *   - "https:x" and "https:///x", which `new URL` reads as host "x", name no page (Claude 2's NIT on #5024, 7061724274);
 *   - a host with no dot ("https://x/y"), user information before the host, IPv6 brackets or a trailing dot is refused;
 *   - an IP literal ("https://1.2.3.4/y") is dotted but names no domain to review, so it is refused too: a top-level
 *     domain is never all digits, and the URL parser turns any host ending in a number into an IPv4 address or refuses it
 *     (Claude 5's NIT on #5334, 7099077097).
 * A refused source makes the figure unknown, and unknown fails; it never becomes zero.
 * Pure: no IO.
 */
export function httpsSource(value: unknown): boolean {
  if (typeof value !== "string" || !value.startsWith("https://")) return false;
  try {
    const url = new URL(value);
    const host = url.hostname;
    return url.protocol === "https:"
      && /^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/.test(host)
      && !/^\d+$/.test(host.slice(host.lastIndexOf(".") + 1))
      && value.slice("https://".length).toLowerCase().startsWith(host);
  } catch {
    return false;
  }
}
