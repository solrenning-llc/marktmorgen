/**
 * The words of the "Visit us" block on a store page (lib/visit-us.ts, 521
 * [LB2]), in each language a store can speak. Everything inside the block is
 * the creator's own: the address, the hours and the number are shown as typed.
 *
 * Browser-safe: plain data, nothing from the server.
 */
import { type LanguageCode, parseLanguage } from "@/lib/store-language";

export type VisitWords = {
  /** The block's heading. */
  heading: string;
  address: string;
  hours: string;
  phone: string;
  /** The phone link's purpose, read with the number (2.4.4). */
  call: (phone: string) => string;
};

const en: VisitWords = { heading: "Visit us", address: "Address", hours: "Opening hours", phone: "Phone", call: (phone) => `Call ${phone}` };
const es: VisitWords = { heading: "Visítanos", address: "Dirección", hours: "Horario", phone: "Teléfono", call: (phone) => `Llamar al ${phone}` };
const fr: VisitWords = { heading: "Venez nous voir", address: "Adresse", hours: "Horaires d'ouverture", phone: "Téléphone", call: (phone) => `Appeler le ${phone}` };
const de: VisitWords = { heading: "Besuchen Sie uns", address: "Adresse", hours: "Öffnungszeiten", phone: "Telefon", call: (phone) => `${phone} anrufen` };
const it: VisitWords = { heading: "Vieni a trovarci", address: "Indirizzo", hours: "Orari di apertura", phone: "Telefono", call: (phone) => `Chiama il ${phone}` };
const nl: VisitWords = { heading: "Kom langs", address: "Adres", hours: "Openingstijden", phone: "Telefoon", call: (phone) => `Bel ${phone}` };
const pt: VisitWords = { heading: "Visite-nos", address: "Morada", hours: "Horário", phone: "Telefone", call: (phone) => `Ligar para ${phone}` };

export const VISIT_WORDS: Record<LanguageCode, VisitWords> = { en, es, fr, de, it, nl, pt };

export function visitWords(language: unknown): VisitWords {
  return VISIT_WORDS[parseLanguage(language)];
}
