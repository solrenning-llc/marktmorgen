/**
 * Whether a piece of text names one address, compared whole (Codex G on #4321): a person's copy (lib/person-copy.ts)
 * picks import rows, report lines, emails waiting and webhook bodies by the addresses in them, and a substring test
 * put another person's data in it whenever their address only contained this one ("nina@example.com.au",
 * "xnina@example.com" for "nina@example.com"). Each address-shaped token in the text is taken whole, lower-cased, a
 * trailing full stop dropped (an address ending a sentence), and compared exactly.
 */
//
// Letters and digits are any script's (\p{L}, \p{N}) with their combining marks (\p{M}), because the import takes an
// address like "josé@müller.de" (Claude 3 cloud S on #4321): a token cut at the first non-ASCII letter never equals
// it, and the person's own rows went missing from their copy. Both sides are compared in NFC, so a decomposed "é"
// in the text is the same address.
const ADDRESS_TOKEN = /[\p{L}\p{N}\p{M}.!#$%&'*+/=?^_`{|}~-]+@[\p{L}\p{N}\p{M}.-]+/gu;

const canonical = (value: string) => value.normalize("NFC").toLowerCase();

export function namesAddress(text: string, address: string): boolean {
  const wanted = canonical(address.trim());
  if (!wanted || !text) return false;
  for (const token of canonical(text).match(ADDRESS_TOKEN) ?? []) {
    if (token.replace(/\.+$/, "") === wanted) return true;
  }
  return false;
}
