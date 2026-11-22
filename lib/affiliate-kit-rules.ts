/**
 * Posts an affiliate shares, drafted for them (added 11 October 2026;
 * lib/affiliate-kit.ts, lib/ai.ts writeAffiliatePosts).
 *
 * An approved affiliate picks one of the store's products and, if they like,
 * says in a line who they share with and how they know the product. Three
 * posts come back — for X, Instagram and LinkedIn — written from the
 * product's own page, in the store's language, as a recommendation in the
 * affiliate's voice. Each one carries their own link to the product and,
 * always, a line saying they earn from it.
 *
 * That line is not left to the model. It is written here, in each language,
 * and added to every post after the model answers, so no draft can go out
 * without it: in the United States the FTC holds the brand responsible for an
 * affiliate's undisclosed recommendation, and in Europe the law on unfair
 * commercial practices asks the same. The model is also told never to claim
 * the affiliate used the product unless their own line says so, and never to
 * promise a result.
 *
 * Who pays for it. Each draft is one of the store's own writing jobs for the
 * month (lib/ai-rules.ts, AI_MONTHLY), which every plan's price already
 * covers, so it costs nothing a plan was not priced for. Two limits keep it
 * the creator's: a few drafts a day for each affiliate, and never more than a
 * quarter of the store's month for its affiliates together. The creator can
 * switch it off (AffiliateSetting.kit).
 *
 * Browser-safe.
 */
import type { LanguageCode } from "@/lib/store-language";

/**
 * One kit's own database work at its worst (Codex P-20261120-1412): the fenced take of its three counters (KIT_COUNTS
 * "take": EVAL, HGET, GET and three INCR with their EXPIRE, 9), their fenced return (KIT_COUNTS "back": EVAL, the same
 * HGET and GET, MGET and three DECR, 7; Claude 1 2as on #5101) and the three content reads (the listing, the about
 * text, the page): 19. Priced as each integration's commands (tests/plan-cost-registry.ts, figure "integration").
 */
export const KIT_COMMANDS_MOST = 19;

/** Drafts one affiliate may ask for in a day. */
export const KIT_PER_DAY = 3;
/** The share of a store's month of writing jobs its affiliates may use together. */
export const KIT_SHARE = 0.25;

/** Drafts all of a store's affiliates together may ask for in a month, out of the store's own allowance. */
export function kitMonthly(allowance: number): number {
  return Math.floor(allowance * KIT_SHARE);
}
/** What an affiliate may say about themselves and the product. */
export const MAX_KIT_NOTE = 300;

/** The line every post ends with: that the link earns them a commission. */
export const DISCLOSURE: Record<LanguageCode, string> = {
  en: "Affiliate link: I earn a commission if you buy through it.",
  es: "Enlace de afiliado: gano una comisión si compras a través de él.",
  fr: "Lien affilié : je touche une commission si vous achetez par ce lien.",
  de: "Affiliate-Link: Ich erhalte eine Provision, wenn Sie darüber kaufen.",
  it: "Link di affiliazione: guadagno una commissione se acquisti tramite questo link.",
  nl: "Affiliatelink: ik verdien een commissie als je via deze link koopt.",
  pt: "Ligação de afiliado: recebo uma comissão se comprar através dela.",
};

/** The shortest form, for X, where every character counts. */
export const DISCLOSURE_SHORT: Record<LanguageCode, string> = {
  en: "#ad (affiliate link)",
  es: "#publicidad (enlace de afiliado)",
  fr: "#publicité (lien affilié)",
  de: "#Werbung (Affiliate-Link)",
  it: "#adv (link di affiliazione)",
  nl: "#advertentie (affiliatelink)",
  pt: "#publicidade (ligação de afiliado)",
};

export type AffiliatePosts = { x: string; instagram: string; linkedin: string };

/**
 * A post as the affiliate copies it: what the model wrote, with any address
 * it wrote taken out, then their link, then the line saying they earn from
 * it. Done here, not by the model, so it cannot be left off.
 */
export function finishPost(body: string, link: string, disclosure: string): string {
  const words = body.replace(/https?:\/\/\S+/g, "").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  return `${words}\n\n${link}\n${disclosure}`;
}

/** Whether a finished post still says what it must: the link and the disclosure. */
export function isDisclosed(post: string, link: string, disclosure: string): boolean {
  return post.includes(link) && post.includes(disclosure);
}
