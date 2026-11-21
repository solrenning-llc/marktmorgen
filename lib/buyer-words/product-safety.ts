/**
 * The words around the legal information a creator fills on a physical
 * product (618 [SZ2] unit 3; components/product-safety-facts.tsx), in every
 * language a store sells in. The values themselves (names, addresses,
 * warnings, the Proposition 65 text) are the creator's, shown as typed.
 * Units are always written out (AX274, 3.1.4). Browser-safe.
 */
import type { BaseUnit } from "@/lib/physical-legal";
import { type LanguageCode, parseLanguage } from "@/lib/store-language";

const S = " ";

const en = {
  heading: "Product safety and manufacturer",
  manufacturer: "Manufacturer",
  responsible: "EU responsible person",
  type: "Product type or model",
  identifier: "Batch or serial number",
  warnings: "Warnings and safety information",
  /** The creator's own statement, never inferred from an empty field. */
  noWarnings: (store: string) => `${store} states that this product has no warnings.`,
  prop65: "California Proposition 65",
  unitPrice: (price: string, per: string) => `Unit price: ${price} ${per}`,
  /** One price of a product with several, by its name. */
  optionUnit: (label: string, price: string, per: string) => `${label}, unit price: ${price} ${per}`,
  per: { kg: "per kilogram", l: "per liter", m: "per meter", m2: "per square meter", m3: "per cubic meter" } as Record<BaseUnit, string>,
};

export type ProductSafetyWords = typeof en;

const es: ProductSafetyWords = {
  heading: "Seguridad del producto y fabricante",
  manufacturer: "Fabricante",
  responsible: "Persona responsable en la UE",
  type: "Tipo o modelo de producto",
  identifier: "Lote o número de serie",
  warnings: "Advertencias e información de seguridad",
  noWarnings: (store) => `${store} declara que este producto no tiene advertencias.`,
  prop65: "Proposición 65 de California",
  unitPrice: (price, per) => `Precio unitario: ${price} ${per}`,
  optionUnit: (label, price, per) => `${label}, precio unitario: ${price} ${per}`,
  per: { kg: "por kilogramo", l: "por litro", m: "por metro", m2: "por metro cuadrado", m3: "por metro cúbico" },
};

const fr: ProductSafetyWords = {
  heading: "Sécurité du produit et fabricant",
  manufacturer: "Fabricant",
  responsible: "Personne responsable dans l'UE",
  type: "Type ou modèle du produit",
  identifier: "Lot ou numéro de série",
  warnings: "Avertissements et consignes de sécurité",
  noWarnings: (store) => `${store} déclare que ce produit ne comporte aucun avertissement.`,
  prop65: "Proposition 65 de Californie",
  unitPrice: (price, per) => `Prix unitaire${S}: ${price} ${per}`,
  optionUnit: (label, price, per) => `${label}, prix unitaire${S}: ${price} ${per}`,
  per: { kg: "le kilogramme", l: "le litre", m: "le mètre", m2: "le mètre carré", m3: "le mètre cube" },
};

const de: ProductSafetyWords = {
  heading: "Produktsicherheit und Hersteller",
  manufacturer: "Hersteller",
  responsible: "Verantwortliche Person in der EU",
  type: "Produkttyp oder Modell",
  identifier: "Charge oder Seriennummer",
  warnings: "Warnhinweise und Sicherheitsinformationen",
  noWarnings: (store) => `${store} erklärt, dass dieses Produkt keine Warnhinweise hat.`,
  prop65: "Kalifornien, Proposition 65",
  unitPrice: (price, per) => `Grundpreis: ${price} ${per}`,
  optionUnit: (label, price, per) => `${label}, Grundpreis: ${price} ${per}`,
  per: { kg: "pro Kilogramm", l: "pro Liter", m: "pro Meter", m2: "pro Quadratmeter", m3: "pro Kubikmeter" },
};

const it: ProductSafetyWords = {
  heading: "Sicurezza del prodotto e fabbricante",
  manufacturer: "Fabbricante",
  responsible: "Persona responsabile nell'UE",
  type: "Tipo o modello del prodotto",
  identifier: "Lotto o numero di serie",
  warnings: "Avvertenze e informazioni sulla sicurezza",
  noWarnings: (store) => `${store} dichiara che questo prodotto non ha avvertenze.`,
  prop65: "Proposition 65 della California",
  unitPrice: (price, per) => `Prezzo unitario: ${price} ${per}`,
  optionUnit: (label, price, per) => `${label}, prezzo unitario: ${price} ${per}`,
  per: { kg: "al chilogrammo", l: "al litro", m: "al metro", m2: "al metro quadrato", m3: "al metro cubo" },
};

const nl: ProductSafetyWords = {
  heading: "Productveiligheid en fabrikant",
  manufacturer: "Fabrikant",
  responsible: "Verantwoordelijke persoon in de EU",
  type: "Producttype of model",
  identifier: "Partij- of serienummer",
  warnings: "Waarschuwingen en veiligheidsinformatie",
  noWarnings: (store) => `${store} verklaart dat dit product geen waarschuwingen heeft.`,
  prop65: "Californische Proposition 65",
  unitPrice: (price, per) => `Eenheidsprijs: ${price} ${per}`,
  optionUnit: (label, price, per) => `${label}, eenheidsprijs: ${price} ${per}`,
  per: { kg: "per kilogram", l: "per liter", m: "per meter", m2: "per vierkante meter", m3: "per kubieke meter" },
};

const pt: ProductSafetyWords = {
  heading: "Segurança do produto e fabricante",
  manufacturer: "Fabricante",
  responsible: "Pessoa responsável na UE",
  type: "Tipo ou modelo do produto",
  identifier: "Lote ou número de série",
  warnings: "Avisos e informações de segurança",
  noWarnings: (store) => `${store} declara que este produto não tem avisos.`,
  prop65: "Proposição 65 da Califórnia",
  unitPrice: (price, per) => `Preço unitário: ${price} ${per}`,
  optionUnit: (label, price, per) => `${label}, preço unitário: ${price} ${per}`,
  per: { kg: "por quilograma", l: "por litro", m: "por metro", m2: "por metro quadrado", m3: "por metro cúbico" },
};

export const PRODUCT_SAFETY_WORDS: Record<LanguageCode, ProductSafetyWords> = { en, es, fr, de, it, nl, pt };

export function productSafetyWords(language: unknown): ProductSafetyWords {
  return PRODUCT_SAFETY_WORDS[parseLanguage(language)];
}
