/**
 * Where a community's members are, roughly, the rules only (398 [SL2], unit 1;
 * added 12 November 2026). The list that a map would draw from, and the
 * accessible alternative to it: countries and cities with how many members
 * said they are there. Pure and browser-safe; the member's choice in their
 * profile, the creator's tab and any map are later units, none of it is on,
 * and nothing here turns a place into coordinates (no geocoding, no tiles).
 *
 *   - Asked for: a member is counted only when they chose to show their place
 *     (off until they do), are let in and not removed; the creator's tab
 *     being on is not consent.
 *   - Approximate, and the member's own words: a country from the list and,
 *     if they want, a city typed by them. A city with a digit (a street
 *     number, a postal code), an address-like word, a link or more than a
 *     few words is refused and said, never cut or guessed; nothing is ever
 *     taken from an IP address or a device's location.
 *   - Nobody stands out: a city with fewer than MIN_GROUP members is folded
 *     into "Other places in <country>", and a country with fewer than
 *     MIN_GROUP into "Other countries". Names are never part of it.
 *   - The same place typed in other letters ("são paulo", "Sao Paulo") is one
 *     city, shown as most of its members wrote it.
 */

/** The fewest members a city or country shows by name. */
export const MIN_GROUP = 3;
export const MAX_CITY_CHARS = 60;
export const MAX_CITY_WORDS = 5;

export type PlaceProblem = "country" | "city-long" | "city-digits" | "city-address" | "city-words";

export const PLACE_PROBLEMS: Record<PlaceProblem, string> = {
  country: "Pick your country from the list.",
  "city-long": `Keep the city to ${MAX_CITY_CHARS} characters or fewer.`,
  "city-digits": "Write only the city's name, with no street number or postal code.",
  "city-address": "Write only the city's name, not a street or an address.",
  "city-words": `Write only the city's name, in up to ${MAX_CITY_WORDS} words.`,
};

const regionNames = (() => {
  try {
    return new Intl.DisplayNames(["en-US"], { type: "region" });
  } catch {
    return null;
  }
})();

/** A country's name in US English for an ISO 3166 two-letter code, or null when it is not one. */
export function countryName(code: unknown): string | null {
  if (typeof code !== "string" || !/^[A-Z]{2}$/.test(code) || !regionNames) return null;
  // Codes for groups or for nowhere in particular are not a place to say one lives.
  if (["EU", "EZ", "UN", "XA", "XB", "ZZ", "AA", "QO"].includes(code)) return null;
  const name = regionNames.of(code);
  return name && name !== code ? name : null;
}

const ADDRESS_WORD = /\b(street|st|avenue|ave|road|rd|rua|av|calle|strasse|straße|apt|apartment|suite|floor|block|lane|ln|drive|dr|boulevard|blvd|po box|zip|cep)\b/i;

/** A member's place, checked: a country code and an optional city in plain words. */
export function cleanPlace(raw: { country?: unknown; city?: unknown }): { ok: true; country: string; city: string } | { ok: false; reason: PlaceProblem } {
  const country = typeof raw.country === "string" ? raw.country.trim().toUpperCase() : "";
  if (!countryName(country)) return { ok: false, reason: "country" };
  const city = typeof raw.city === "string" ? raw.city.replace(/\s+/g, " ").trim() : "";
  if (!city) return { ok: true, country, city: "" };
  if ([...city].length > MAX_CITY_CHARS) return { ok: false, reason: "city-long" };
  if (/\p{Nd}/u.test(city)) return { ok: false, reason: "city-digits" };
  if (ADDRESS_WORD.test(city) || /[@/\\:#<>]|www\./i.test(city)) return { ok: false, reason: "city-address" };
  if (city.split(" ").length > MAX_CITY_WORDS) return { ok: false, reason: "city-words" };
  return { ok: true, country, city };
}

export type PlacedMember = { shows: boolean; removed: boolean; access: boolean | null; country: string; city: string };

export type PlaceList = {
  countries: { country: string; name: string; members: number; cities: { city: string; members: number }[]; otherInCountry: number }[];
  otherCountries: number;
  /** Members who chose to show a place and are counted. */
  shown: number;
  /** Members left out because whether they are let in could not be read. */
  unread: number;
};

const fold = (city: string) => city.normalize("NFKD").replace(/\p{M}/gu, "").toLocaleLowerCase("en-US");

/** The list by country and city, with every group under MIN_GROUP folded away. */
export function placeList(members: readonly PlacedMember[]): PlaceList {
  let unread = 0;
  const counted: { country: string; city: string }[] = [];
  for (const m of members) {
    if (!m.shows || m.removed || m.access === false) continue;
    if (m.access === null) {
      unread += 1;
      continue;
    }
    const place = cleanPlace(m);
    if (place.ok) counted.push(place);
  }
  const byCountry = new Map<string, { country: string; city: string }[]>();
  for (const p of counted) byCountry.set(p.country, [...(byCountry.get(p.country) ?? []), p]);
  const countries: PlaceList["countries"] = [];
  let otherCountries = 0;
  for (const [country, rows] of byCountry) {
    if (rows.length < MIN_GROUP) {
      otherCountries += rows.length;
      continue;
    }
    const byCity = new Map<string, string[]>();
    for (const r of rows) if (r.city) byCity.set(fold(r.city), [...(byCity.get(fold(r.city)) ?? []), r.city]);
    const cities: { city: string; members: number }[] = [];
    let small = rows.filter((r) => !r.city).length;
    for (const spellings of byCity.values()) {
      if (spellings.length < MIN_GROUP) {
        small += spellings.length;
        continue;
      }
      // Shown as most wrote it; a tie goes to the spelling written as a name is (a capital first, then its accents), then the
      // first in the alphabet, so it is the same every time.
      const tally = new Map<string, number>();
      for (const s of spellings) tally.set(s, (tally.get(s) ?? 0) + 1);
      const capital = (s: string) => (/^\p{Lu}/u.test(s) ? 1 : 0);
      const accents = (s: string) => s.normalize("NFKD").length - s.length;
      const city = [...tally].sort((a, b) => b[1] - a[1] || capital(b[0]) - capital(a[0]) || accents(b[0]) - accents(a[0]) || a[0].localeCompare(b[0]))[0][0];
      cities.push({ city, members: spellings.length });
    }
    cities.sort((a, b) => b.members - a.members || a.city.localeCompare(b.city));
    countries.push({ country, name: countryName(country) ?? country, members: rows.length, cities, otherInCountry: small });
  }
  countries.sort((a, b) => b.members - a.members || a.name.localeCompare(b.name));
  return { countries, otherCountries, shown: counted.length, unread };
}

/** The list as lines a screen reader or a plain page reads: "Brazil: 12 members (São Paulo 5, Other places in Brazil 7)". */
export function placeLines(list: PlaceList): string[] {
  const members = (n: number) => `${n.toLocaleString("en-US")} ${n === 1 ? "member" : "members"}`;
  const lines = list.countries.map((c) => {
    const parts = [...c.cities.map((city) => `${city.city} ${city.members.toLocaleString("en-US")}`), ...(c.otherInCountry ? [`Other places in ${c.name} ${c.otherInCountry.toLocaleString("en-US")}`] : [])];
    return `${c.name}: ${members(c.members)}${parts.length ? ` (${parts.join(", ")})` : ""}`;
  });
  if (list.otherCountries) lines.push(`Other countries: ${members(list.otherCountries)}`);
  return lines;
}
