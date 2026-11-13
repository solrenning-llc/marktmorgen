/**
 * Whether a piece of text names one address, compared whole (Codex G on #4321): a person's copy (lib/person-copy.ts)
 * picks import rows, report lines, emails waiting and webhook bodies by the addresses in them, and a substring test
 * put another person's data in it whenever their address only contained this one ("nina@example.com.au",
 * "xnina@example.com" for "nina@example.com"). Each address-shaped token in the text is taken whole, lower-cased, a
 * trailing full stop dropped (an address ending a sentence), and compared exactly.
 */
const ADDRESS_TOKEN = /[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9.-]+/gi;

export function namesAddress(text: string, address: string): boolean {
  const wanted = address.trim().toLowerCase();
  if (!wanted || !text) return false;
  for (const token of text.match(ADDRESS_TOKEN) ?? []) {
    if (token.toLowerCase().replace(/\.+$/, "") === wanted) return true;
  }
  return false;
}
