/**
 * Where a community's members are, roughly (lib/member-places.ts, 398 [SL2]
 * unit 1; added 12 November 2026). Synthetic members only. Checked:
 *
 *   - a country from the list and a city in plain words; digits, address
 *     words, links and long text refused, never cut;
 *   - only members who chose to show it, let in and not removed; unread
 *     access leaves the member out and is counted apart;
 *   - a city or country with fewer than 3 is folded away, so nobody stands
 *     out; the same city in other letters is one city;
 *   - the plain-text lines say the same as the list, with no names.
 */
import { MIN_GROUP, PLACE_PROBLEMS, type PlacedMember, cleanPlace, countryName, placeLines, placeList } from "@/lib/member-places";
import { done, is, part } from "./check";

const why = (r: ReturnType<typeof cleanPlace>) => (r.ok ? "ok" : r.reason);
const m = (country: string, city = "", over: Partial<PlacedMember> = {}): PlacedMember => ({ shows: true, removed: false, access: true, country, city, ...over });
const times = (n: number, member: PlacedMember) => Array.from({ length: n }, () => ({ ...member }));

part("A place in the member's own plain words");
is("a country and a city", cleanPlace({ country: "br", city: "  São   Paulo " }), { ok: true, country: "BR", city: "São Paulo" });
is("a country alone is fine", cleanPlace({ country: "PT" }), { ok: true, country: "PT", city: "" });
is("not a country", [why(cleanPlace({ country: "ZZ" })), why(cleanPlace({ country: "EU" })), why(cleanPlace({ country: "QQ" })), why(cleanPlace({ country: "Brazil" }))], ["country", "country", "country", "country"]);
is("a street number or postal code is refused", [why(cleanPlace({ country: "US", city: "Austin 78701" })), why(cleanPlace({ country: "US", city: "12 Main" }))], ["city-digits", "city-digits"]);
is("an address word is refused", [why(cleanPlace({ country: "US", city: "Main Street" })), why(cleanPlace({ country: "BR", city: "Rua Augusta" }))], ["city-address", "city-address"]);
is("a link or an email is refused", [why(cleanPlace({ country: "US", city: "www.example" })), why(cleanPlace({ country: "US", city: "me@home" }))], ["city-address", "city-address"]);
is("too long, or too many words", [why(cleanPlace({ country: "US", city: "a".repeat(61) })), why(cleanPlace({ country: "US", city: "one two three four five six" }))], ["city-long", "city-words"]);
is("a city with an apostrophe or a hyphen is a city", [why(cleanPlace({ country: "US", city: "Coeur d'Alene" })), why(cleanPlace({ country: "FR", city: "Aix-en-Provence" }))], ["ok", "ok"]);
is("every refusal has its words", Object.values(PLACE_PROBLEMS).every((w) => w.length > 15), true);
is("a country's name in US English", countryName("DE"), "Germany");

part("Only those who chose to show it");
{
  const list = placeList([...times(3, m("BR", "Recife")), m("BR", "Recife", { shows: false }), m("BR", "Recife", { removed: true }), m("BR", "Recife", { access: false }), m("BR", "Recife", { access: null })]);
  is("hidden, removed and without access are not counted", list.shown, 3);
  is("unread access is left out and counted apart", list.unread, 1);
}

part("Nobody stands out");
{
  const list = placeList([
    ...times(MIN_GROUP, m("BR", "São Paulo")),
    m("BR", "sao paulo"),
    m("BR", "Sao Paulo"),
    ...times(2, m("BR", "Recife")),
    m("BR"),
    ...times(2, m("PT", "Lisbon")),
    m("JP", "Tokyo"),
  ]);
  is("cities under 3 fold into the country; the same city in other letters is one", list.countries.map((c) => [c.country, c.members, c.cities, c.otherInCountry]), [["BR", 8, [{ city: "São Paulo", members: 5 }], 3]]);
  is("countries under 3 fold into other countries", list.otherCountries, 3);
  is("the lines say the same, with no names", placeLines(list), ["Brazil: 8 members (São Paulo 5, Other places in Brazil 3)", "Other countries: 3 members"]);
  const two = placeList(times(2, m("US", "Austin")));
  is("two members alone show nothing by name", [two.countries.length, two.otherCountries], [0, 2]);
  const tie = placeList([m("BR", "Sao Paulo"), m("BR", "São Paulo"), m("BR", "sao paulo")]);
  is("a tie in spelling goes to the one written as a name is, the same every time", tie.countries[0]?.cities[0]?.city, "São Paulo");
}

done();
