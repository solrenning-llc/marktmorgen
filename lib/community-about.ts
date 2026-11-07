/**
 * A community's public About page (233 [SK1], app/[handle]/community/about):
 * what somebody who is not in yet may know before deciding to join.
 *
 * Off until the creator turns it on (lib/community-about-setting.ts); while
 * off, or while the community itself is off, the page is not found. When on,
 * it shows only:
 *
 *   - the community's name and the description the creator wrote for people
 *     who are not in yet (the same words the community's own door shows);
 *   - the ways in: the products that open it and are on sale now
 *     (canSellProduct: published, priced, deliverable, on a store that can
 *     sell), each with its published price and how many of the community's
 *     spaces it opens, linked to the product's own page, which is the
 *     checkout's door. A draft or anything that cannot be bought is left out;
 *   - with the creator's second choice, two counts: how many people have
 *     joined (everyone who has come in, as the studio counts them) and how
 *     many posts were written in the last 30 days. Small numbers are shown as
 *     they are. A count that cannot be read is left out, never shown as 0.
 *
 * No post, comment, lesson, event title, space name or member appears:
 * nothing paid for, and nobody who did not choose to be shown.
 *
 * What it costs: the page is one of the store's public requests (isResting,
 * which also rests it with the store's other pages), its products are paid
 * for before they are read (listingUnits, as other public pages), and the
 * counts are worked out at most once every ABOUT_FRESH_SECONDS and kept
 * (nl:cm:<id>:about): the visit that finds them out of date pays
 * ABOUT_REFRESH_UNITS requests before reading, and is refused, with no
 * counts shown, when the store's requests are used up. Every other visit
 * reads the kept counts, one command. Held in tests/sk1-community-about.test.ts.
 */
import type { Store } from "@/lib/store";
import { isFree } from "@/lib/store";
import { type Listing, readListings } from "@/lib/catalog";
import { canSellProduct, fromPriceCents } from "@/lib/store-checkout";
import { type CommunityConfig, readConfig, readConfigExact } from "@/lib/community";
import { seesSpace } from "@/lib/community-gate";
import { isResting, takePublicRequest } from "@/lib/traffic";
import { listingUnits } from "@/lib/public-read-rules";
import { productSegment } from "@/lib/product-slug";
import { membershipLine, speech } from "@/lib/buyer-words";
import { communityWords } from "@/lib/buyer-words/community";
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { countOf, repliesFor, stringList } from "@/lib/redis-reply";
import type { LanguageCode } from "@/lib/store-language";

/** How long kept counts are shown before the next visit works them out again; also how long they are kept. */
export const ABOUT_FRESH_SECONDS = 6 * 60 * 60;
/** The days of posts counted as the community's recent activity. */
export const ACTIVITY_DAYS = 30;
/** The newest posts read to count them: past this many, the page says "at least". */
export const ABOUT_POSTS_READ = 20;
/** The most one post's record may weigh as it is kept (its title, text, poll and picture, escaped as JSON), a review ceiling. */
export const ABOUT_POST_BYTES = 32_768;
/** What working the counts out sends: the kept counts read, the members counted, the feed's newest, the posts, the counts kept. */
export const ABOUT_REFRESH_COMMANDS = 5;
/** What it reads, at the most. */
export const ABOUT_REFRESH_BYTES = ABOUT_POSTS_READ * ABOUT_POST_BYTES + 4_096;
/** The store's public requests working the counts out takes, before it reads (tests/sk1-community-about.test.ts holds them against its cost). */
export const ABOUT_REFRESH_UNITS = 2;

const COMMUNITY = /^[0-9a-f]{32}$/;
const aboutKey = (id: string) => `nl:cm:${id}:about`;

export type AboutWay = {
  id: string;
  title: string;
  /** Its kind and published price, in the store's language: "Membership · $20 a month". */
  kind: string;
  /** The product's own page, where the checkout opens. */
  href: string;
  /** How many of the community's spaces it opens. */
  spaces: number;
};

export type AboutCounts = {
  /** Everyone who has come in; null when it could not be read. */
  joined: number | null;
  /** Posts in the last ACTIVITY_DAYS days, hidden ones left out; null when they could not be read. */
  posts: { n: number; atLeast: boolean } | null;
};

export type AboutPage = {
  name: string;
  about: string;
  ways: AboutWay[];
  /** How many spaces the community has. */
  spaces: number;
  /** Null when the creator does not show them, or when they could not be worked out. */
  counts: AboutCounts | null;
};

export type AboutAnswer = { state: "none" } | { state: "resting" } | { state: "shown"; page: AboutPage };

/** Its kind and published price, as the community's own door says it, with how often a membership is paid. */
function kindOf(store: Store, product: Listing): string {
  const w = communityWords(store.language);
  if (isFree(product)) return w.ticketFree;
  const { money } = speech(store);
  const price = money(fromPriceCents(product));
  if (product.recurring) return w.ticketMembership(membershipLine(store, product.recurring, price));
  if (product.course) return w.ticketCourse(price);
  if (product.call) return w.ticketCall(price);
  return price;
}

/**
 * What the About page of this store's community shows, or why it shows
 * nothing: "none" (not found: no community, switched off, page off) or
 * "resting" (the store's public requests are used up).
 */
export async function aboutPage(store: Store, now = Date.now()): Promise<AboutAnswer> {
  const id = store.community?.id;
  if (!id || !store.community?.on || store.suspended) return { state: "none" };
  const config = await readConfig(id);
  if (!config || !config.page.on) return { state: "none" };
  // The page is one of the store's public requests, counted before anything more is read.
  if (await isResting(store, now)) return { state: "resting" };
  if (config.access.length && !(await takePublicRequest(store, "public", now, listingUnits(config.access.length)))) return { state: "resting" };
  const products = config.access.length ? await readListings(store, config.access) : [];
  const ways = products
    .filter((p) => canSellProduct(store, p))
    .map((p) => ({
      id: p.id,
      title: p.title,
      kind: kindOf(store, p),
      href: `/@${store.handle}/p/${productSegment(p)}`,
      spaces: config.spaces.filter((s) => seesSpace(s, config.access, new Set([p.id]))).length,
    }));
  const counts = config.page.counts ? await aboutCounts(store, id, config, now) : null;
  return { state: "shown", page: { name: config.name, about: config.about, ways, spaces: config.spaces.length, counts } };
}

/**
 * Whether the store's map for search engines lists the About page
 * (lib/store-sitemap.ts): only while the community is on, the store is not
 * switched off and the creator's setting reads exactly on. A setting that
 * cannot be read (a lost reply, one that does not parse, no setup yet)
 * leaves it out, as the page itself answers not found then. One command,
 * read after the map is paid for and counted in its cost line
 * (tests/plan-cost-registry.ts, sitemapRead).
 */
export async function aboutListed(store: Store): Promise<boolean> {
  const id = store.community?.id;
  if (!id || !store.community?.on || store.suspended) return false;
  try {
    return (await readConfigExact(id))?.page.on === true;
  } catch {
    return false;
  }
}

type Kept = { at: number; joined: number; posts: number; more: boolean };

/**
 * What the posts read say, as the page may show it. None counted while the
 * window read was full ("at least" none) says nothing about the recent posts
 * past it, so it is unknown and left out, never shown as "no posts"
 * (Codex K2 on #3016).
 */
function shownPosts(n: number, more: boolean): AboutCounts["posts"] {
  return n === 0 && more ? null : { n, atLeast: more };
}

function readKept(raw: unknown): Kept | null {
  if (typeof raw !== "string") return null;
  try {
    const v = JSON.parse(raw) as Partial<Kept>;
    const whole = (n: unknown) => typeof n === "number" && Number.isSafeInteger(n) && n >= 0;
    if (!whole(v.at) || !whole(v.joined) || !whole(v.posts) || typeof v.more !== "boolean") return null;
    return v as Kept;
  } catch {
    return null;
  }
}

/**
 * How many have joined and how many posts were written lately: the kept
 * counts while they are fresh, else worked out again by this visit, which
 * pays for it first. Null when the store's requests refuse it. A count that
 * cannot be read comes back null on its own, and nothing is kept, so the
 * next visit tries again.
 */
export async function aboutCounts(
  store: Store,
  id: string,
  config: CommunityConfig,
  now = Date.now(),
): Promise<AboutCounts | null> {
  if (!COMMUNITY.test(id) || !isRedisConfigured() || !config.page.counts) return null;
  const at = Math.floor(now / 1000);
  const [stored] = repliesFor(await redisPipeline([["GET", aboutKey(id)]]), 1) ?? [undefined];
  const kept = readKept(stored);
  if (kept && kept.at <= at && at - kept.at < ABOUT_FRESH_SECONDS) return { joined: kept.joined, posts: shownPosts(kept.posts, kept.more) };

  if (!(await takePublicRequest(store, "public", now, ABOUT_REFRESH_UNITS))) return null;
  const first = repliesFor(
    await redisPipeline([
      ["HLEN", `nl:cm:${id}:m`],
      ["ZREVRANGE", `nl:cm:${id}:feed`, 0, ABOUT_POSTS_READ - 1],
    ]),
    2,
  );
  const joined = first ? countOf(first[0]) : null;
  const listed = first ? stringList(first[1]) : null;
  // More ids than were asked for is not the feed's newest: unknown, and nothing past the window is read.
  const ids = listed && listed.length <= ABOUT_POSTS_READ ? listed : null;
  let read: { n: number; more: boolean } | null = null;
  if (ids && ids.length === 0) read = { n: 0, more: false };
  else if (ids) {
    const [rows] = repliesFor(await redisPipeline([["MGET", ...ids.map((p) => `nl:cm:${id}:p:${p}`)]]), 1) ?? [null];
    const records = repliesFor(rows, ids.length);
    if (records && records.every((r) => r === null || typeof r === "string")) {
      const since = at - ACTIVITY_DAYS * 86_400;
      let n = 0;
      let allRecent = true;
      let unknown = false;
      for (const raw of records as (string | null)[]) {
        // Deleted while it was read: it no longer counts.
        if (raw === null) continue;
        let post: { at?: unknown; hid?: unknown };
        try {
          post = JSON.parse(raw) as { at?: unknown; hid?: unknown };
        } catch {
          unknown = true;
          break;
        }
        // A time that is not whole seconds from 1970 up to now is not a post's time: unknown, not a recent post.
        if (typeof post.at !== "number" || !Number.isSafeInteger(post.at) || post.at < 0 || post.at > at) {
          unknown = true;
          break;
        }
        if (post.at < since) allRecent = false;
        else if (post.hid !== true) n += 1;
      }
      // The newest ABOUT_POSTS_READ all recent, and maybe more before them: "at least".
      if (!unknown) read = { n, more: allRecent && ids.length === ABOUT_POSTS_READ };
    }
  }
  // A full window of hidden posts is kept as read (shown as unknown), so the next visits do not pay to read it again.
  if (joined !== null && read !== null) {
    const value: Kept = { at, joined, posts: read.n, more: read.more };
    await redisPipeline([["SET", aboutKey(id), JSON.stringify(value), "EX", ABOUT_FRESH_SECONDS]]);
  }
  return { joined, posts: read ? shownPosts(read.n, read.more) : null };
}

export type AboutWords = {
  label: string;
  byline: (store: string) => string;
  meta: (name: string, store: string) => string;
  activity: string;
  joined: (n: number, num?: (n: number) => string) => string;
  posts: (n: number, atLeast: boolean, num?: (n: number) => string) => string;
  counted: string;
  join: string;
  opens: (k: number, m: number) => string;
  noneNow: string;
  membersOnly: string;
  open: string;
  /** The link to the About page on the community's door, naming the community (WCAG 2.4.9). */
  link: (name: string) => string;
};

const en: AboutWords = {
  label: "About this community",
  byline: (s) => `A community by ${s}`,
  meta: (name, s) => `${name}, a community by ${s} on Marktmorgen.`,
  activity: "Members and activity",
  joined: (n, f = String) => (n === 0 ? "Nobody has joined yet" : n === 1 ? "1 person has joined" : `${f(n)} people have joined`),
  posts: (n, atLeast, f = String) =>
    atLeast ? (n === 1 ? "At least 1 post in the last 30 days" : `At least ${f(n)} posts in the last 30 days`) : n === 0 ? "No posts in the last 30 days" : n === 1 ? "1 post in the last 30 days" : `${f(n)} posts in the last 30 days`,
  counted: "Counted at most six hours ago.",
  join: "How to join",
  opens: (k, m) => (k >= m ? "Opens every space" : `Opens ${k} of its ${m} spaces`),
  noneNow: "No way in is on sale right now.",
  membersOnly: "Posts, lessons, events and members are seen only inside the community.",
  open: "Open the community",
  link: (n) => `About ${n}`,
};

const es: AboutWords = {
  label: "Sobre esta comunidad",
  byline: (s) => `Una comunidad de ${s}`,
  meta: (name, s) => `${name}, una comunidad de ${s} en Marktmorgen.`,
  activity: "Miembros y actividad",
  joined: (n, f = String) => (n === 0 ? "Todavía no se ha unido nadie" : n === 1 ? "Se ha unido 1 persona" : `Se han unido ${f(n)} personas`),
  posts: (n, atLeast, f = String) =>
    atLeast ? (n === 1 ? "Al menos 1 publicación en los últimos 30 días" : `Al menos ${f(n)} publicaciones en los últimos 30 días`) : n === 0 ? "Ninguna publicación en los últimos 30 días" : n === 1 ? "1 publicación en los últimos 30 días" : `${f(n)} publicaciones en los últimos 30 días`,
  counted: "Contado hace seis horas como máximo.",
  join: "Cómo unirse",
  opens: (k, m) => (k >= m ? "Abre todos los espacios" : `Abre ${k} de sus ${m} espacios`),
  noneNow: "Ahora mismo no hay ningún acceso a la venta.",
  membersOnly: "Las publicaciones, las lecciones, los eventos y los miembros solo se ven dentro de la comunidad.",
  open: "Abrir la comunidad",
  link: (n) => `Sobre ${n}`,
};

const fr: AboutWords = {
  label: "À propos de cette communauté",
  byline: (s) => `Une communauté de ${s}`,
  meta: (name, s) => `${name}, une communauté de ${s} sur Marktmorgen.`,
  activity: "Membres et activité",
  joined: (n, f = String) => (n === 0 ? "Personne ne l’a encore rejointe" : n === 1 ? "1 personne l’a rejointe" : `${f(n)} personnes l’ont rejointe`),
  posts: (n, atLeast, f = String) =>
    atLeast ? (n === 1 ? "Au moins 1 publication ces 30 derniers jours" : `Au moins ${f(n)} publications ces 30 derniers jours`) : n === 0 ? "Aucune publication ces 30 derniers jours" : n === 1 ? "1 publication ces 30 derniers jours" : `${f(n)} publications ces 30 derniers jours`,
  counted: "Compté il y a six heures au plus.",
  join: "Comment la rejoindre",
  opens: (k, m) => (k >= m ? "Ouvre tous les espaces" : `Ouvre ${k} de ses ${m} espaces`),
  noneNow: "Aucun accès n’est en vente pour le moment.",
  membersOnly: "Les publications, les leçons, les événements et les membres ne se voient qu’à l’intérieur de la communauté.",
  open: "Ouvrir la communauté",
  link: (n) => `À propos de ${n}`,
};

const de: AboutWords = {
  label: "Über diese Community",
  byline: (s) => `Eine Community von ${s}`,
  meta: (name, s) => `${name}, eine Community von ${s} auf Marktmorgen.`,
  activity: "Mitglieder und Aktivität",
  joined: (n, f = String) => (n === 0 ? "Noch ist niemand beigetreten" : n === 1 ? "1 Person ist beigetreten" : `${f(n)} Personen sind beigetreten`),
  posts: (n, atLeast, f = String) =>
    atLeast ? (n === 1 ? "Mindestens 1 Beitrag in den letzten 30 Tagen" : `Mindestens ${f(n)} Beiträge in den letzten 30 Tagen`) : n === 0 ? "Keine Beiträge in den letzten 30 Tagen" : n === 1 ? "1 Beitrag in den letzten 30 Tagen" : `${f(n)} Beiträge in den letzten 30 Tagen`,
  counted: "Höchstens vor sechs Stunden gezählt.",
  join: "So trittst du bei",
  opens: (k, m) => (k >= m ? "Öffnet alle Bereiche" : `Öffnet ${k} ihrer ${m} Bereiche`),
  noneNow: "Derzeit ist kein Zugang zu kaufen.",
  membersOnly: "Beiträge, Lektionen, Veranstaltungen und Mitglieder sind nur in der Community zu sehen.",
  open: "Community öffnen",
  link: (n) => `Über ${n}`,
};

const it: AboutWords = {
  label: "Informazioni su questa community",
  byline: (s) => `Una community di ${s}`,
  meta: (name, s) => `${name}, una community di ${s} su Marktmorgen.`,
  activity: "Membri e attività",
  joined: (n, f = String) => (n === 0 ? "Non si è ancora unito nessuno" : n === 1 ? "Si è unita 1 persona" : `Si sono unite ${f(n)} persone`),
  posts: (n, atLeast, f = String) =>
    atLeast ? `Almeno ${f(n)} post negli ultimi 30 giorni` : n === 0 ? "Nessun post negli ultimi 30 giorni" : `${f(n)} post negli ultimi 30 giorni`,
  counted: "Contati al massimo sei ore fa.",
  join: "Come entrare",
  opens: (k, m) => (k >= m ? "Apre tutti gli spazi" : `Apre ${k} dei suoi ${m} spazi`),
  noneNow: "Al momento non c’è un accesso in vendita.",
  membersOnly: "Post, lezioni, eventi e membri si vedono solo all’interno della community.",
  open: "Apri la community",
  link: (n) => `Informazioni su ${n}`,
};

const nl: AboutWords = {
  label: "Over deze community",
  byline: (s) => `Een community van ${s}`,
  meta: (name, s) => `${name}, een community van ${s} op Marktmorgen.`,
  activity: "Leden en activiteit",
  joined: (n, f = String) => (n === 0 ? "Nog niemand is lid geworden" : n === 1 ? "1 persoon is lid geworden" : `${f(n)} mensen zijn lid geworden`),
  posts: (n, atLeast, f = String) =>
    atLeast ? (n === 1 ? "Minstens 1 bericht in de afgelopen 30 dagen" : `Minstens ${f(n)} berichten in de afgelopen 30 dagen`) : n === 0 ? "Geen berichten in de afgelopen 30 dagen" : n === 1 ? "1 bericht in de afgelopen 30 dagen" : `${f(n)} berichten in de afgelopen 30 dagen`,
  counted: "Hooguit zes uur geleden geteld.",
  join: "Zo word je lid",
  opens: (k, m) => (k >= m ? "Opent alle ruimtes" : `Opent ${k} van de ${m} ruimtes`),
  noneNow: "Er is op dit moment geen toegang te koop.",
  membersOnly: "Berichten, lessen, evenementen en leden zijn alleen binnen de community te zien.",
  open: "Open de community",
  link: (n) => `Over ${n}`,
};

const pt: AboutWords = {
  label: "Sobre esta comunidade",
  byline: (s) => `Uma comunidade de ${s}`,
  meta: (name, s) => `${name}, uma comunidade de ${s} na Marktmorgen.`,
  activity: "Membros e atividade",
  joined: (n, f = String) => (n === 0 ? "Ainda ninguém aderiu" : n === 1 ? "Aderiu 1 pessoa" : `Aderiram ${f(n)} pessoas`),
  posts: (n, atLeast, f = String) =>
    atLeast ? (n === 1 ? "Pelo menos 1 publicação nos últimos 30 dias" : `Pelo menos ${f(n)} publicações nos últimos 30 dias`) : n === 0 ? "Nenhuma publicação nos últimos 30 dias" : n === 1 ? "1 publicação nos últimos 30 dias" : `${f(n)} publicações nos últimos 30 dias`,
  counted: "Contado há seis horas, no máximo.",
  join: "Como aderir",
  opens: (k, m) => (k >= m ? "Abre todos os espaços" : `Abre ${k} dos seus ${m} espaços`),
  noneNow: "De momento, não há nenhum acesso à venda.",
  membersOnly: "As publicações, as lições, os eventos e os membros só se veem dentro da comunidade.",
  open: "Abrir a comunidade",
  link: (n) => `Sobre ${n}`,
};

const WORDS: Record<LanguageCode, AboutWords> = { en, es, fr, de, it, nl, pt };

export function aboutWords(language: unknown): AboutWords {
  return typeof language === "string" && Object.hasOwn(WORDS, language) ? WORDS[language as LanguageCode] : en;
}
