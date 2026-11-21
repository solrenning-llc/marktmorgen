/**
 * 793 [IV3] unit 4: the UK VAT rate of each kind of goods or services, read from HMRC's public guidance "VAT rates on
 * different goods and services" under the owner's authorization (OWNER-20261121-1529-ART9A-PENDING-DECISIONS, item 1:
 * the public page only, no account, no API key, no terms).
 *
 *   - The page was read through GOV.UK's public content API on 21/11/2026 and is kept byte for byte at
 *     `UK_VAT_RATES_FILE.path`, with its SHA-256; its last update is 10 July 2026. `tests/uk-vat-product-rates.test.ts`
 *     checks the file against the SHA-256 and every row below against the file's own tables.
 *   - Each row is exactly as the page writes it: the page's section, the goods or services, the rate and the notice.
 *   - `ukProductRateBps` gives a rate only for a row written "0%", "5%" or "Standard-rated" (the standard rate is
 *     `UK_VAT_RATE` in lib/uk-vat.ts, read on gov.uk/vat-rates). Anything else is refused, never 0%: "Exempt", a rate
 *     with a condition ("0% or 5%", "Exempt if ..."), "Outside the scope of VAT" and "The same rate as the goods ...",
 *     whose condition this table does not hold; a row the table does not have; two rows that disagree; and any day
 *     past `UK_VAT_PRODUCT_RATES_VALID_UNTIL`, before which the page is read again at the source, with the date.
 *
 * Pure. Nothing calls it yet: which row a store's product falls under is the next step, and collecting UK VAT stays off
 * (UK_VAT_COLLECT_REVIEWED, lib/vat-registrations.ts).
 */
import { UK_VAT_RATE } from "@/lib/uk-vat";

export const UK_VAT_RATES_FILE = {
  path: "docs/gov-uk-vat-rates/vat-rates-on-different-goods-and-services.json",
  source: "https://www.gov.uk/api/content/guidance/vat-rates-on-different-goods-and-services",
  page: "https://www.gov.uk/guidance/vat-rates-on-different-goods-and-services",
  readOn: "2026-11-21",
  pageUpdatedOn: "2026-07-10",
  sha256: "00778c28b854cd47f63c3feac8bee3aa1c7d80ce0bf051791960b8ee2e18ee23",
} as const;

/** The page is read again at the source before this day; past it no row gives a rate. */
export const UK_VAT_PRODUCT_RATES_VALID_UNTIL = "2026-12-31";

export type UkProductRateRow = { section: string; item: string; rate: string; more: string };

export const UK_VAT_PRODUCT_RATES: readonly UkProductRateRow[] = [
  { section: "Sport, leisure, culture and antiques", item: "Physical education and sports activities", rate: "Exempt", more: "VAT Notice 701/45" },
  { section: "Sport, leisure, culture and antiques", item: "Betting and gaming — including pool betting and games of chance", rate: "Exempt", more: "VAT Notice 701/29" },
  { section: "Sport, leisure, culture and antiques", item: "Bingo — including remote games played on the internet, telephone, television or radio", rate: "Exempt", more: "VAT Notice 701/29" },
  { section: "Sport, leisure, culture and antiques", item: "Lottery ticket sales", rate: "Exempt", more: "VAT Notice 701/29" },
  { section: "Sport, leisure, culture and antiques", item: "Online lottery games", rate: "Exempt", more: "VAT Notice 701/29" },
  { section: "Sport, leisure, culture and antiques", item: "Retailer commission on lottery ticket sales", rate: "Exempt", more: "VAT Notice 701/29" },
  { section: "Sport, leisure, culture and antiques", item: "Admission charges by public authorities or eligible cultural bodies to certain cultural events such as visits to museums, art exhibitions, zoos and performances", rate: "Exempt", more: "VAT Notice 701/47" },
  { section: "Sport, leisure, culture and antiques", item: "Antiques, works of art or similar (as assets of historic houses) sold by private treaty to public collections", rate: "Exempt", more: "VAT Notice 701/12" },
  { section: "Sport, leisure, culture and antiques", item: "Antiques, works of art or similar (as assets of historic houses) used to settle a tax or estate duty debt with HMRC", rate: "Exempt", more: "VAT Notice 701/12" },
  { section: "Health, education, welfare and charities", item: "Admission charges by charities", rate: "Exempt", more: "How VAT applies to charities" },
  { section: "Health, education, welfare and charities", item: "Advertising services for charities", rate: "0%", more: "VAT Notice 701/58" },
  { section: "Health, education, welfare and charities", item: "Certain goods sold at charitable fundraising events", rate: "0%", more: "Charity fund-raising events and VAT" },
  { section: "Health, education, welfare and charities", item: "Charitable fundraising events", rate: "Exempt", more: "Charity fundraising events and VAT" },
  { section: "Health, education, welfare and charities", item: "Charity shops — selling donated goods", rate: "0%", more: "Charitable donations and VAT" },
  { section: "Health, education, welfare and charities", item: "Construction and sale of new buildings for a relevant charitable purpose", rate: "0%", more: "VAT Notice 708" },
  { section: "Health, education, welfare and charities", item: "Energy-saving materials permanently installed in dwellings and buildings used for a relevant residential purpose providing the total cost of them (not including VAT) is not over 60% of the cost of the installation of the products (not including VAT)", rate: "5%", more: "Energy-saving materials — supply only — are standard-rated — VAT Notice 708/6" },
  { section: "Health, education, welfare and charities", item: "Sponsored charitable events", rate: "Exempt", more: "Charities and VAT" },
  { section: "Health, education, welfare and charities", item: "Voluntary donations to charity", rate: "Outside the scope of VAT", more: "Donations to charities" },
  { section: "Health, education, welfare and charities", item: "Building services for disabled people", rate: "0%", more: "Notice 701/7 VAT reliefs for disabled people" },
  { section: "Health, education, welfare and charities", item: "Burial or cremation of dead people, or burial at sea", rate: "Exempt", more: "VAT Notice 701/32" },
  { section: "Health, education, welfare and charities", item: "Mobility aids for the elderly", rate: "5%", more: "Mobility aids for older people" },
  { section: "Health, education, welfare and charities", item: "Equipment for blind or partially sighted people", rate: "0%", more: "Equipment for blind or partially sighted people" },
  { section: "Health, education, welfare and charities", item: "Equipment for disabled people", rate: "0%", more: "Equipment for disabled people" },
  { section: "Health, education, welfare and charities", item: "Funeral plans written under contracts of insurance", rate: "Exempt", more: "VAT Notice 701/36" },
  { section: "Health, education, welfare and charities", item: "Smoking cessation products — nicotine patches and gum", rate: "5%", more: "Read Budget Note BN77 (PDF, 42K)" },
  { section: "Health, education, welfare and charities", item: "Welfare services provided by charities at significantly below cost", rate: "Outside the scope of VAT", more: "VAT Notice 701/1" },
  { section: "Health, education, welfare and charities", item: "Magnetic tape adapted for recording speech for blind people together with apparatus for making and playing the adapted tape and certain low vision aids", rate: "0%", more: "Aids for blind people" },
  { section: "Health, education, welfare and charities", item: "Care or medical treatment provided by a qualifying institution like a hospital, hospice or nursing home", rate: "Exempt", more: "VAT Notice 701/31" },
  { section: "Health, education, welfare and charities", item: "Dispensing of prescriptions by a registered pharmacist", rate: "0%", more: "VAT Notice 701/57" },
  { section: "Health, education, welfare and charities", item: "Health services provided by registered doctors, dentists, opticians, pharmacists and other health professionals", rate: "Exempt", more: "VAT Notice 701/57" },
  { section: "Health, education, welfare and charities", item: "Incontinence products", rate: "0%", more: "VAT Notice 701/7" },
  { section: "Health, education, welfare and charities", item: "Maternity pads", rate: "0%", more: "VAT Notice 701/18" },
  { section: "Health, education, welfare and charities", item: "Sanitary protection products", rate: "0%", more: "VAT Notice 701/18" },
  { section: "Health, education, welfare and charities", item: "Low vision aids", rate: "0%", more: "Equipment for blind or partially sighted people" },
  { section: "Health, education, welfare and charities", item: "Education and vocational training provided by an eligible body other than a ‘private school’. Goods or services closely connected to the education provided by an eligible body like a school, college or university", rate: "Exempt", more: "VAT Notice 701/30" },
  { section: "Power, utilities, energy and energy saving, heating", item: "Electricity for domestic and residential use or for non-business use by a charity", rate: "5%", more: "Fuel for business use is usually standard-rated — VAT Notice 701/19" },
  { section: "Power, utilities, energy and energy saving, heating", item: "Gas for domestic and residential use or for non-business use by a charity", rate: "5%", more: "Fuel for business use is usually standard-rated — VAT Notice 701/19" },
  { section: "Power, utilities, energy and energy saving, heating", item: "Heating oil for domestic and residential use or for non-business use by a charity", rate: "5%", more: "Fuel for business use is usually standard-rated — VAT Notice 701/19" },
  { section: "Power, utilities, energy and energy saving, heating", item: "Solid fuel for domestic and residential use or for non-business use by a charity", rate: "5%", more: "Fuel for business use is usually standard-rated — VAT Notice 701/19" },
  { section: "Power, utilities, energy and energy saving, heating", item: "Cesspools, septic tanks or similar (domestic) — emptying", rate: "0%", more: "Emptying industrial cesspools, septic tanks or similar is standard-rated — VAT Water and Sewerage Services manual" },
  { section: "Power, utilities, energy and energy saving, heating", item: "Sewerage services supplied to domestic or industrial customers", rate: "0%", more: "Sewer and drain cleaning, unblocking or maintenance is standard-rated — VAT Water and Sewerage Services manual" },
  { section: "Power, utilities, energy and energy saving, heating", item: "Water supplied to households", rate: "0%", more: "Water supplied to industrial customers is standard-rated — VAT Water and Sewerage Services manual" },
  { section: "Power, utilities, energy and energy saving, heating", item: "Installed goods", rate: "VAT rate", more: "More information" },
  { section: "Power, utilities, energy and energy saving, heating", item: "Air source heat pumps", rate: "0%", more: "VAT Notice 708/6" },
  { section: "Power, utilities, energy and energy saving, heating", item: "Boilers — wood fuelled", rate: "0%", more: "VAT Notice 708/6" },
  { section: "Power, utilities, energy and energy saving, heating", item: "Central heating and hot water controls", rate: "0%", more: "VAT Notice 708/6" },
  { section: "Power, utilities, energy and energy saving, heating", item: "Draught stripping", rate: "0%", more: "VAT Notice 708/6" },
  { section: "Power, utilities, energy and energy saving, heating", item: "Ground source heat pumps", rate: "0%", more: "VAT Notice 708/6" },
  { section: "Power, utilities, energy and energy saving, heating", item: "Insulation", rate: "0%", more: "VAT Notice 708/6" },
  { section: "Power, utilities, energy and energy saving, heating", item: "Micro combined heat and power units", rate: "0%", more: "VAT Notice 708/6" },
  { section: "Power, utilities, energy and energy saving, heating", item: "Solar panels", rate: "0%", more: "VAT Notice 708/6" },
  { section: "Power, utilities, energy and energy saving, heating", item: "Water and wind turbines", rate: "0%", more: "VAT Notice 708/6" },
  { section: "Power, utilities, energy and energy saving, heating", item: "Water source heat pumps", rate: "0%", more: "VAT Notice 708/6" },
  { section: "Power, utilities, energy and energy saving, heating", item: "Electrical storage batteries", rate: "0%", more: "VAT Notice 708/6" },
  { section: "Power, utilities, energy and energy saving, heating", item: "Smart diverters", rate: "0%", more: "VAT Notice 708/6" },
  { section: "Power, utilities, energy and energy saving, heating", item: "Installed goods", rate: "VAT rate", more: "More information" },
  { section: "Power, utilities, energy and energy saving, heating", item: "Closed solid fuel fire cassettes", rate: "5%", more: "VAT Notice 708/6" },
  { section: "Power, utilities, energy and energy saving, heating", item: "Electric dual immersion water heaters with factory-insulated hot water tanks", rate: "5%", more: "VAT Notice 708/6" },
  { section: "Power, utilities, energy and energy saving, heating", item: "Electric storage heaters", rate: "5%", more: "VAT Notice 708/6" },
  { section: "Power, utilities, energy and energy saving, heating", item: "Gas-fired boilers", rate: "5%", more: "VAT Notice 708/6" },
  { section: "Power, utilities, energy and energy saving, heating", item: "Gas room heaters with thermostatic controls", rate: "5%", more: "VAT Notice 708/6" },
  { section: "Power, utilities, energy and energy saving, heating", item: "Oil-fired boilers", rate: "5%", more: "VAT Notice 708/6" },
  { section: "Power, utilities, energy and energy saving, heating", item: "Radiators", rate: "5%", more: "VAT Notice 708/6" },
  { section: "Power, utilities, energy and energy saving, heating", item: "The installation, repair and maintenance of a boiler, radiators, pipework and controls forming a central heating system (including micro combined heat and power systems)", rate: "5%", more: "VAT Notice 708/6" },
  { section: "Power, utilities, energy and energy saving, heating", item: "The installation, repair and maintenance of renewable source heating systems. This means space or water heating systems which use energy from: renewable sources, including solar, wind and hydroelectric power; or near renewable sources, including ground and air heat", rate: "5%", more: "VAT Notice 708/6" },
  { section: "Power, utilities, energy and energy saving, heating", item: "Connection or reconnection to the mains gas supply", rate: "5%", more: "VAT Notice 708/6" },
  { section: "Building and construction, land and property", item: "Substantial reconstructions to protected buildings that are buildings used as a dwelling, for a relevant residential purpose or for a relevant charitable purpose", rate: "0%", more: "VAT Notice 708" },
  { section: "Building and construction, land and property", item: "The installation of a bathroom or lavatory, constructing ramps and widening doorways or passageways for disabled people in their own home", rate: "0%", more: "Building services for disabled people" },
  { section: "Building and construction, land and property", item: "Construction and first freehold or long leasehold sale of a new building for a relevant charitable purpose", rate: "0%", more: "VAT Notice 708" },
  { section: "Building and construction, land and property", item: "Construction and first freehold or long leasehold sale of a new building for relevant residential purposes", rate: "0%", more: "VAT Notice 708" },
  { section: "Building and construction, land and property", item: "Construction and first freehold or long leasehold sale of new domestic buildings", rate: "0%", more: "VAT Notice 708" },
  { section: "Building and construction, land and property", item: "Converting existing premises by increasing the number of dwellings within the building", rate: "5%", more: "VAT Notice 708" },
  { section: "Building and construction, land and property", item: "Renovating a dwelling that has been empty for at least 2 years", rate: "5%", more: "VAT Notice 708" },
  { section: "Building and construction, land and property", item: "First freehold or long leasehold sale of a commercial building converted into a dwelling or dwellings", rate: "0%", more: "VAT Notice 708" },
  { section: "Building and construction, land and property", item: "First freehold or long leasehold sale of buildings converted for relevant residential purposes", rate: "0%", more: "VAT Notice 708" },
  { section: "Building and construction, land and property", item: "First freehold or long leasehold sale of buildings converted for relevant charitable purposes", rate: "0%", more: "VAT Notice 708" },
  { section: "Building and construction, land and property", item: "Garages or parking spaces let together with dwellings (under shorthold tenancy agreements) for permanent residential use", rate: "Exempt", more: "Garages or facilities specially designed for parking are standard-rated — VAT Notice 742" },
  { section: "Building and construction, land and property", item: "Parking — grant, or licence, to occupy land on which incidental parking takes place", rate: "Exempt", more: "VAT Notice 742" },
  { section: "Building and construction, land and property", item: "Property, land and buildings — grant, or licence, to occupy land or buildings", rate: "Exempt", more: "VAT Notice 742" },
  { section: "Building and construction, land and property", item: "Sale or long lease of a new dwelling with garage or parking space", rate: "0%", more: "VAT Notice 708" },
  { section: "Transport, freight, travel and vehicles", item: "Aircraft repair and maintenance", rate: "0%", more: "VAT Notice 744C" },
  { section: "Transport, freight, travel and vehicles", item: "Freight transport to or from a place outside the UK", rate: "0%", more: "Domestic freight transport is standard-rated, unless it is the domestic leg of freight transport between the UK and another country (0%). — VAT Notice 744B" },
  { section: "Transport, freight, travel and vehicles", item: "Freight containers — sale, lease or hire to a place outside the UK and the EU", rate: "0%", more: "VAT Notice 703/1" },
  { section: "Transport, freight, travel and vehicles", item: "International freight transport that takes place in the UK and its territorial waters", rate: "0%", more: "VAT Notice 744B" },
  { section: "Transport, freight, travel and vehicles", item: "Houseboat moorings", rate: "Exempt", more: "VAT Notice 742" },
  { section: "Transport, freight, travel and vehicles", item: "Parking spaces or garages supplied with houseboat moorings", rate: "Exempt", more: "VAT Notice 742" },
  { section: "Transport, freight, travel and vehicles", item: "Passenger transport in a vehicle, boat or aircraft that carries not less than 10 passengers", rate: "0%", more: "VAT Notice 744A" },
  { section: "Transport, freight, travel and vehicles", item: "Tolls for bridges, tunnels and roads operated by public authorities", rate: "Outside the scope of VAT", more: "Privately-operated tolls for bridges, tunnels and roads are standard-rated — VAT Notice 700" },
  { section: "Transport, freight, travel and vehicles", item: "Aircraft repair and maintenance", rate: "0%", more: "VAT Notice 744C" },
  { section: "Transport, freight, travel and vehicles", item: "Airships — sale or charter", rate: "0%", more: "VAT Notice 744C" },
  { section: "Transport, freight, travel and vehicles", item: "Caravans (more than 7 metres long or more than 2.55 metres wide)", rate: "0% or 5%", more: "Taxing holiday caravans" },
  { section: "Transport, freight, travel and vehicles", item: "Civil aeroplanes — sale or charter", rate: "0%", more: "Gliders — sale or charter — are standard-rated as are hot air balloons — VAT Notice 744C" },
  { section: "Transport, freight, travel and vehicles", item: "Helicopters — sale or charter", rate: "0%", more: "VAT Notice 744C" },
  { section: "Transport, freight, travel and vehicles", item: "Houseboats — sale or let out on hire", rate: "0%", more: "But holiday accommodation let in a moored houseboat is standard-rated — VAT Notice 701/20" },
  { section: "Transport, freight, travel and vehicles", item: "Military aeroplanes — sale or charter", rate: "0%", more: "VAT Notice 744C" },
  { section: "Transport, freight, travel and vehicles", item: "Ship repairs and maintenance", rate: "0%", more: "VAT Notice 744C" },
  { section: "Transport, freight, travel and vehicles", item: "Shipbuilding — 15 tons or over gross tonnage", rate: "0%", more: "VAT Notice 744C" },
  { section: "Printing, postage, publications — books, magazines and newspapers", item: "Brochures", rate: "0%", more: "VAT Notice 701/10" },
  { section: "Printing, postage, publications — books, magazines and newspapers", item: "Leaflets", rate: "0%", more: "VAT Notice 701/10" },
  { section: "Printing, postage, publications — books, magazines and newspapers", item: "Pamphlets", rate: "0%", more: "VAT Notice 701/10" },
  { section: "Printing, postage, publications — books, magazines and newspapers", item: "Direct-mail postal services meeting all the conditions of VAT Notice 700/24 3.2 and 3.3", rate: "Outside the scope of VAT", more: "VAT Notice 700/24" },
  { section: "Printing, postage, publications — books, magazines and newspapers", item: "Postage, packing and delivery within the UK included in the sales contract but charged for separately, for example, mail order", rate: "The same rate as the goods being delivered or posted", more: "Postage, packing and delivery within the UK charged as an optional extra is always standard-rated — VAT Notice 700/24" },
  { section: "Printing, postage, publications — books, magazines and newspapers", item: "Public postal services provided by the Royal Mail under a universal service obligation", rate: "Exempt", more: "Standard Royal Mail first and second class services for example" },
  { section: "Printing, postage, publications — books, magazines and newspapers", item: "Other postal services that are not subject to a universal service obligation", rate: "Standard-rated", more: "Supplies that are not subject to regulation" },
  { section: "Printing, postage, publications — books, magazines and newspapers", item: "Books", rate: "0%", more: "VAT Notice 701/10" },
  { section: "Printing, postage, publications — books, magazines and newspapers", item: "Children’s painting and picture books", rate: "0%", more: "VAT Notice 701/10" },
  { section: "Printing, postage, publications — books, magazines and newspapers", item: "Maps and charts", rate: "0%", more: "VAT Notice 701/10" },
  { section: "Printing, postage, publications — books, magazines and newspapers", item: "Magazines", rate: "0%", more: "VAT Notice 701/10" },
  { section: "Printing, postage, publications — books, magazines and newspapers", item: "Newspapers", rate: "0%", more: "VAT Notice 701/10" },
  { section: "Printing, postage, publications — books, magazines and newspapers", item: "Printed or copied music", rate: "0%", more: "VAT Notice 701/10" },
  { section: "Printing, postage, publications — books, magazines and newspapers", item: "Publications", rate: "0%", more: "Some items are standard-rated such as exercise books, letterheads, posters — VAT Notice 701/10" },
  { section: "Clothing and footwear, protective and safety equipment", item: "Babywear", rate: "0%", more: "VAT Notice 714" },
  { section: "Clothing and footwear, protective and safety equipment", item: "Children’s clothes and footwear", rate: "0%", more: "VAT Notice 714" },
  { section: "Clothing and footwear, protective and safety equipment", item: "Carrycots with restraint straps", rate: "5%", more: "VAT Notice 701/23" },
  { section: "Clothing and footwear, protective and safety equipment", item: "Children’s car seats, booster seats and booster cushions", rate: "5%", more: "VAT Notice 701/23" },
  { section: "Clothing and footwear, protective and safety equipment", item: "Children’s safety seats with bare wheeled framework", rate: "5%", more: "Prams and pushchairs are standard-rated — VAT Notice 701/23" },
  { section: "Clothing and footwear, protective and safety equipment", item: "Cycle helmets — CE marked", rate: "0%", more: "VAT Notice 701/23" },
  { section: "Clothing and footwear, protective and safety equipment", item: "Motorcycle helmets that meet safety standards", rate: "0%", more: "VAT Notice 701/23" },
  { section: "Clothing and footwear, protective and safety equipment", item: "Protective boots and helmets for industrial use", rate: "0%", more: "VAT Notice 701/23" },
  { section: "Financial services and investments, insurance", item: "Financial services including the issue, transfer or receipt of, or dealing with money, securities for money or orders for the payment of money", rate: "Exempt", more: "VAT Notice 701/49" },
  { section: "Financial services and investments, insurance", item: "The granting of credit such as loans", rate: "Exempt", more: "VAT Notice 701/49" },
  { section: "Financial services and investments, insurance", item: "The management of credit by the person who has granted it", rate: "Exempt", more: "VAT Notice 701/49" },
  { section: "Financial services and investments, insurance", item: "The provision of the facility of instalment credit finance for example hire-purchase", rate: "Exempt", more: "VAT Notice 701/49" },
  { section: "Financial services and investments, insurance", item: "The provision of qualifying financial intermediary services", rate: "Exempt", more: "VAT Notice 701/49" },
  { section: "Financial services and investments, insurance", item: "The issue, transfer or dealing with a security, including shares and bonds", rate: "Exempt", more: "VAT Notice 701/49" },
  { section: "Financial services and investments, insurance", item: "The operation of a current, deposit or savings account", rate: "Exempt", more: "VAT Notice 701/49" },
  { section: "Financial services and investments, insurance", item: "The management of a qualifying special investment fund", rate: "Exempt", more: "VAT Notice 701/49" },
  { section: "Financial services and investments, insurance", item: "Financial service supplied as a separate element but with other goods or services", rate: "Exempt", more: "VAT Notice 701/49" },
  { section: "Financial services and investments, insurance", item: "Financial service supplied as part of a single supply with other goods or services", rate: "Exempt if financial service is the principal element of the supply", more: "VAT Notice 701/49" },
  { section: "Financial services and investments, insurance", item: "Gold investment coins", rate: "Exempt", more: "VAT Notice 701/21" },
  { section: "Financial services and investments, insurance", item: "Friendly society subscriptions for the provision of insurance", rate: "Exempt", more: "VAT Notice 701/36" },
  { section: "Financial services and investments, insurance", item: "Insurance and reinsurance transactions", rate: "Exempt", more: "VAT Notice 701/36" },
  { section: "Financial services and investments, insurance", item: "Insurance brokers and agents acting in an intermediary capacity", rate: "Exempt", more: "VAT Notice 701/36" },
  { section: "Financial services and investments, insurance", item: "Insurance supplied as a separate element but with other goods or services", rate: "Exempt", more: "VAT Notice 701/36" },
  { section: "Financial services and investments, insurance", item: "Insurance supplied as part of a single supply with other goods or services", rate: "Exempt if insurance is the principal element of the supply", more: "VAT Notice 701/36" },
];

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const realDay = (value: unknown): value is string => {
  if (typeof value !== "string" || !DAY.test(value)) return false;
  const time = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value;
};

function basisPointsOf(rate: string): number | null {
  if (rate === "0%") return 0;
  if (rate === "5%") return 500;
  if (rate === "Standard-rated") return UK_VAT_RATE.basisPoints;
  return null;
}

/**
 * The UK VAT rate, in basis points, of the goods or services the page writes as `item` under `section`, on `day`
 * (YYYY-MM-DD); null when the table cannot give one: unknown is refused, never 0%.
 */
export function ukProductRateBps(section: string, item: string, day: string, table: readonly UkProductRateRow[] = UK_VAT_PRODUCT_RATES): number | null {
  if (!realDay(day) || day > UK_VAT_PRODUCT_RATES_VALID_UNTIL || day < UK_VAT_RATES_FILE.readOn) return null;
  if (typeof section !== "string" || typeof item !== "string" || !Array.isArray(table)) return null;
  const rows = table.filter((row) => row && row.section === section && row.item === item);
  if (rows.length === 0) return null;
  const rates = new Set(rows.map((row) => basisPointsOf(row.rate)));
  if (rates.size !== 1) return null;
  const [rate] = rates;
  return rate ?? null;
}
