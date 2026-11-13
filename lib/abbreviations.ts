/**
 * What the abbreviations in Marktmorgen's own words stand for (WCAG 3.1.4, AX274), in one list so the same letters
 * always expand the same way. components/abbr.tsx draws them.
 */
export const ABBREVIATIONS = {
  API: "application programming interface",
  CRM: "customer relationship management",
  CSV: "comma-separated values",
  DNS: "Domain Name System",
  EPUB: "electronic publication",
  HTML: "HyperText Markup Language",
  ICS: "iCalendar file",
  PDF: "Portable Document Format",
  SKU: "stock keeping unit",
  UTC: "Coordinated Universal Time",
  VAT: "value-added tax",
} as const;

export type Abbreviation = keyof typeof ABBREVIATIONS;
