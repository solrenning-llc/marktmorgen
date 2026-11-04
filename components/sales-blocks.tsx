import type { ReactNode } from "react";
import { Icon } from "@/components/icons";
import { VideoEmbed } from "@/components/video-embed";
import { Countdown } from "@/components/countdown";
import { wordsIn } from "@/lib/buyer-words";
import { DEFAULT_LANGUAGE, LANGUAGES, type LanguageCode } from "@/lib/store-language";
import { imageUrl } from "@/lib/product-image";
import { type Piece, aboutBlocks } from "@/lib/product-about";
import { CELL_NO, CELL_YES, type CtaBlock, type HeroBlock, type PageBlock, type PageStyle, bandsOf, quoteHost } from "@/lib/sales-page";
import { blockWords } from "@/lib/buyer-words/blocks";
import type { PageFacts } from "@/lib/page-facts";
import { MAX_LONG_ANSWER, MAX_SHORT_ANSWER, type FormDef, type FormField, branches, formOpen, offersKeep, scheduleWhen } from "@/lib/forms";
import { FormBranching } from "@/components/form-branching";
import { formWords } from "@/lib/buyer-words/form";
import { FormKeep } from "@/components/form-keep";
import { NewTab } from "@/components/new-tab";

/**
 * The blocks of a product's page, drawn (lib/sales-page.ts says what each is).
 *
 * The same components draw the page a buyer sees and the preview in the
 * studio, so what the creator previews is what goes live. Every word is
 * rendered as text; paragraphs, lists and links are built here from the
 * plain-text rules of the long description, and nothing a creator typed is
 * ever put on the page as markup.
 *
 * Colours come from the store's look (the st-* properties), so a page
 * follows its store's theme without choosing a colour of its own.
 */

/** Where a button on the page leads: straight to the checkout, to a place on the page, or nowhere yet. */
export type PageAction =
  | { kind: "checkout"; handle: string; product: string }
  | { kind: "link"; href: string }
  | { kind: "none"; text: string };

/** What the blocks need to know about the product and its store. */
export type BlockContext = {
  storeName: string;
  productTitle: string;
  /** The product's picture, when it has one. */
  picture: { src: string; alt: string; width: number; height: number } | null;
  /** The creator's photo, when they have one. */
  photo: string | null;
  action: PageAction;
  /** The label a button uses when the creator left it empty. */
  defaultLabel: string;
  /** Drawn in the studio: buttons and links do nothing. */
  preview?: boolean;
  /**
   * The clock when the page was drawn, in seconds, for a countdown's first
   * numbers. Left out in the studio, where the browser's own clock is used.
   */
  now?: number;
  /** The store's language (lib/store-language.ts), for the words the blocks add themselves. */
  lang?: LanguageCode;
  /** The numbers a "By the numbers" block may show, counted by the store (lib/page-facts.ts). */
  facts?: PageFacts;
  /** The store's other products a page may show as a card (lib/sales-page.ts, ProductBlock), by id. */
  featured?: Record<string, FeaturedCard>;
  /** The store's forms a page may ask (lib/forms.ts, FormBlock), by id, and where their answers go. */
  forms?: Record<string, FormDef>;
  formTarget?: { handle: string; page: string; funnel: string; listOpen: boolean };
  /** What happened to a form just sent from this page, to say above it. */
  formNotice?: { form: string; status: string };
};

/** Another product, as its card on a sales page shows it: today's name, picture and price. */
export type FeaturedCard = {
  title: string;
  summary: string;
  /** Its price as the store shows it: "$27", "from €9 a month", "Free". */
  pill: string;
  href: string;
  picture: { src: string; alt: string; width: number; height: number } | null;
};

/** A cell of a comparison: a tick, a cross, or the creator's few words. */
function Cell({ text, ours, ctx }: { text: string; ours: boolean; ctx: BlockContext }) {
  const w = blockWords(ctx.lang ?? DEFAULT_LANGUAGE);
  if (text === CELL_YES || text === CELL_NO) {
    const yes = text === CELL_YES;
    return (
      <span className={`sp-cell-mark ${yes ? "sp-cell-yes" : "sp-cell-no"}`} role="img" aria-label={yes ? w.cellYes : w.cellNo}>
        <Icon name={yes ? "check" : "close"} size={16} strokeWidth={2.4} />
      </span>
    );
  }
  return <span className={ours ? "font-semibold" : ""}>{text}</span>;
}

export function Line({ pieces, preview }: { pieces: Piece[]; preview?: boolean }) {
  return (
    <>
      {pieces.map((piece, i) =>
        piece.href && !preview ? (
          <a key={i} href={piece.href} target="_blank" rel="noopener noreferrer nofollow ugc">
            {piece.text}
          <NewTab /></a>
        ) : (
          <span key={i}>{piece.text}</span>
        ),
      )}
    </>
  );
}

/** Plain text as paragraphs, lists and links: the long description's rules. */
export function PlainText({ text, preview, className = "" }: { text: string; preview?: boolean; className?: string }) {
  const blocks = aboutBlocks(text);
  if (blocks.length === 0) return null;
  return (
    <div className={`st-about leading-relaxed ${className}`}>
      {blocks.map((block, i) =>
        block.kind === "list" ? (
          <ul key={i}>
            {block.items.map((item, j) => (
              <li key={j}>
                <Line pieces={item} preview={preview} />
              </li>
            ))}
          </ul>
        ) : (
          <p key={i}>
            {block.lines.map((row, j) => (
              <span key={j}>
                {j > 0 ? <br /> : null}
                <Line pieces={row} preview={preview} />
              </span>
            ))}
          </p>
        ),
      )}
    </div>
  );
}

/** A button that does what the page's action says. */
export function ActionButton({ ctx, label, large = false }: { ctx: BlockContext; label: string; large?: boolean }) {
  const text = label || ctx.defaultLabel;
  const className = `btn st-btn ${large ? "btn-lg" : ""} sp-cta-btn`;
  if (ctx.action.kind === "none") return <p className="st-muted text-sm font-semibold">{ctx.action.text}</p>;
  if (ctx.preview) {
    return (
      <span className={className}>
        {text}
      </span>
    );
  }
  if (ctx.action.kind === "link") {
    return (
      <a href={ctx.action.href} className={className}>
        {text}
      </a>
    );
  }
  return (
    <form action="/api/store/checkout" method="post" target="_top" data-checkout="" className="contents">
      <input type="hidden" name="handle" value={ctx.action.handle} />
      <input type="hidden" name="product" value={ctx.action.product} />
      <button type="submit" className={className}>
        {text}
      </button>
    </form>
  );
}

/**
 * The top of the page. Its headline is the page's one main heading, so the
 * hero may only ever be the first block.
 */
export function HeroView({ block, ctx, pill, rating }: { block: HeroBlock; ctx: BlockContext; pill: ReactNode; rating: ReactNode }) {
  const video = block.media === "video" ? block.video : null;
  const picture = block.media === "picture" ? ctx.picture : null;
  const hasMedia = Boolean(video || picture);
  // A picture behind the words needs a picture; a video is centred instead (lib/sales-page.ts, HeroLayout).
  const layout = block.layout === "cover" ? (picture ? "cover" : "centered") : block.layout ?? "split";
  const button = block.button ? (
    <div className="sp-hero-button">
      <ActionButton ctx={ctx} label="" large />
    </div>
  ) : null;
  if (layout === "cover" && picture) {
    return (
      <header className="sp-hero sp-hero-cover">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={picture.src} alt={picture.alt} width={picture.width} height={picture.height} fetchPriority="high" className="sp-hero-cover-img" />
        <div className="sp-hero-words">
          <div className="flex flex-wrap items-center gap-2">
            {pill}
            {rating}
          </div>
          <h1 className="font-display mt-4 text-[2.1rem] font-semibold leading-[1.08] tracking-[-0.025em] sm:text-5xl">
            {block.headline || ctx.productTitle}
          </h1>
          {block.sub ? <p className="mt-4 whitespace-pre-line text-lg leading-relaxed sm:text-xl">{block.sub}</p> : null}
          {button}
        </div>
      </header>
    );
  }
  return (
    <header className={`sp-hero ${hasMedia && layout === "split" ? "sp-hero-split" : ""} ${layout === "centered" ? "sp-hero-centered" : ""}`}>
      <div className="sp-hero-words">
        <div className="flex flex-wrap items-center gap-2">
          {pill}
          {rating}
        </div>
        <h1 className="font-display mt-4 text-[2.1rem] font-semibold leading-[1.08] tracking-[-0.025em] sm:text-5xl">
          {block.headline || ctx.productTitle}
        </h1>
        {block.sub ? <p className="st-muted mt-4 whitespace-pre-line text-lg leading-relaxed sm:text-xl">{block.sub}</p> : null}
        {button}
      </div>
      {video ? (
        <div className="sp-hero-media">
          <VideoEmbed video={video} title={block.headline || ctx.productTitle} poster={ctx.picture ? { src: ctx.picture.src, alt: ctx.picture.alt } : null} inert={ctx.preview} lang={ctx.lang ?? DEFAULT_LANGUAGE} />
        </div>
      ) : picture ? (
        <div className="sp-hero-media">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={picture.src}
            alt={picture.alt}
            width={picture.width}
            height={picture.height}
            fetchPriority="high"
            className="st-hero-img"
            style={{ aspectRatio: `${picture.width} / ${picture.height}` }}
          />
        </div>
      ) : null}
    </header>
  );
}

function Heading({ text, id }: { text: string; id?: string }) {
  if (!text) return null;
  return (
    <h2 id={id} className="font-display text-2xl font-semibold leading-tight tracking-[-0.02em] sm:text-[1.75rem]">
      {text}
    </h2>
  );
}

function CtaView({ block, ctx }: { block: CtaBlock; ctx: BlockContext }) {
  return (
    <div className="sp-cta">
      <ActionButton ctx={ctx} label={block.label} large />
      {block.note ? <p className="st-muted mt-3 text-sm">{block.note}</p> : null}
    </div>
  );
}

/**
 * Any block but the hero. `reviews` is what the page puts where the reviews
 * block stands: the reviews themselves, drawn by the page, which knows them.
 */
export function BlockView({ block, ctx, reviews }: { block: PageBlock; ctx: BlockContext; reviews: ReactNode }) {
  switch (block.kind) {
    case "hero":
      return null;
    case "text":
      if (!block.heading && !block.body) return null;
      return (
        <section className="sp-section">
          <Heading text={block.heading} />
          <PlainText text={block.body} preview={ctx.preview} className={block.heading ? "mt-4 text-[1.0625rem]" : "text-[1.0625rem]"} />
        </section>
      );
    case "benefits":
      if (block.items.length === 0) return null;
      return (
        <section className="sp-section">
          <Heading text={block.heading} />
          <ul className={`grid gap-3 sm:grid-cols-2 ${block.heading ? "mt-5" : ""}`}>
            {block.items.map((item, i) => (
              <li key={i} className="sp-benefit">
                <span className="sp-tick" aria-hidden="true">
                  <Icon name="check" size={16} strokeWidth={2.4} />
                </span>
                <span className="font-semibold leading-snug">{item}</span>
              </li>
            ))}
          </ul>
        </section>
      );
    case "inside":
      if (block.items.length === 0) return null;
      return (
        <section className="sp-section">
          <Heading text={block.heading} />
          <ol className={`space-y-3 ${block.heading ? "mt-5" : ""}`}>
            {block.items.map((item, i) => (
              <li key={i} className="sp-inside">
                <span className="sp-number" aria-hidden="true">
                  {i + 1}
                </span>
                <span className="min-w-0">
                  <span className="block font-semibold leading-snug">{item.title}</span>
                  {item.detail ? <span className="st-muted mt-1 block whitespace-pre-line text-[0.9375rem] leading-relaxed">{item.detail}</span> : null}
                </span>
              </li>
            ))}
          </ol>
        </section>
      );
    case "bio":
      if (!block.body) return null;
      return (
        <section className="sp-section">
          <div className="sp-bio">
            {block.photo && ctx.photo ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={ctx.photo} alt="" width={80} height={80} className="st-avatar !mx-0 shrink-0" style={{ width: 80, height: 80 }} loading="lazy" />
            ) : block.photo ? (
              <span aria-hidden="true" className="st-avatar st-avatar-initial !mx-0 shrink-0" style={{ width: 80, height: 80, fontSize: "2rem" }}>
                {ctx.storeName.slice(0, 1).toUpperCase()}
              </span>
            ) : null}
            <div className="min-w-0">
              <Heading text={block.heading || wordsIn(ctx.lang ?? DEFAULT_LANGUAGE).aboutStore(ctx.storeName)} />
              <PlainText text={block.body} preview={ctx.preview} className="mt-3" />
            </div>
          </div>
        </section>
      );
    case "faq":
      if (block.items.length === 0) return null;
      return (
        <section className="sp-section">
          <Heading text={block.heading} />
          <div className={`space-y-3 ${block.heading ? "mt-5" : ""}`}>
            {block.items.map((item, i) => (
              <details key={i} className="sp-faq">
                <summary>
                  <span>{item.q}</span>
                  <Icon name="chevron-down" size={20} className="sp-faq-chevron shrink-0" />
                </summary>
                <PlainText text={item.a} preview={ctx.preview} className="st-muted px-5 pb-5" />
              </details>
            ))}
          </div>
        </section>
      );
    case "guarantee":
      if (!block.body) return null;
      return (
        <section className="sp-section">
          <div className="sp-guarantee">
            <span className="sp-guarantee-icon" aria-hidden="true">
              <Icon name="shield" size={24} />
            </span>
            <div className="min-w-0">
              <Heading text={block.heading || wordsIn(ctx.lang ?? DEFAULT_LANGUAGE).guarantee} />
              <PlainText text={block.body} preview={ctx.preview} className="mt-2" />
            </div>
          </div>
        </section>
      );
    case "cta":
      return (
        <section className="sp-section">
          <CtaView block={block} ctx={ctx} />
        </section>
      );
    case "reviews":
      return reviews ? <section className="sp-section">{reviews}</section> : null;
    case "video":
      if (!block.video) return null;
      return (
        <section className="sp-section">
          <Heading text={block.heading} />
          <div className={block.heading ? "mt-5" : ""}>
            <VideoEmbed video={block.video} title={block.heading || ctx.productTitle} poster={null} inert={ctx.preview} lang={ctx.lang ?? DEFAULT_LANGUAGE} />
          </div>
          {block.caption ? <PlainText text={block.caption} preview={ctx.preview} className="st-muted mt-3" /> : null}
        </section>
      );
    case "pictures":
      if (block.items.length === 0) return null;
      return (
        <section className="sp-section">
          <Heading text={block.heading} />
          <div className={`sp-pictures sp-pictures-${Math.min(block.items.length, 3)} ${block.heading ? "mt-5" : ""}`}>
            {block.items.map((picture) => {
              const image = (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={imageUrl(picture)} alt={picture.alt} width={picture.width} height={picture.height} loading="lazy" decoding="async" />
              );
              return (
                <figure key={picture.path} className="sp-picture">
                  {ctx.preview ? (
                    image
                  ) : (
                    /* The whole picture: a page of a book is read, not glanced at. */
                    <a
                      href={imageUrl(picture)}
                      target="_blank"
                      rel="noopener noreferrer"
                      aria-label={picture.alt ? wordsIn(ctx.lang ?? DEFAULT_LANGUAGE).fullSize(picture.alt) : wordsIn(ctx.lang ?? DEFAULT_LANGUAGE).openFullSize}
                      // Opened large on the page itself where script runs (components/picture-viewer.tsx).
                      data-picture-group={block.id}
                      data-caption={picture.caption || undefined}
                    >
                      {image}
                    <NewTab /></a>
                  )}
                  {picture.caption ? <figcaption className="st-muted mt-2 text-sm leading-snug">{picture.caption}</figcaption> : null}
                </figure>
              );
            })}
          </div>
        </section>
      );
    case "feature": {
      if (!block.body && !block.heading && !block.picture) return null;
      const picture = block.picture;
      return (
        <section className="sp-section">
          <div className={`sp-feature ${picture ? "sp-feature-2" : ""} ${block.side === "right" ? "sp-feature-right" : ""}`}>
            {picture ? (
              <figure className="sp-feature-picture">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={imageUrl(picture)} alt={picture.alt} width={picture.width} height={picture.height} loading="lazy" decoding="async" />
                {picture.caption ? <figcaption className="st-muted mt-2 text-sm leading-snug">{picture.caption}</figcaption> : null}
              </figure>
            ) : null}
            <div className="sp-feature-words">
              <Heading text={block.heading} />
              <PlainText text={block.body} preview={ctx.preview} className={block.heading ? "mt-3 text-[1.0625rem]" : "text-[1.0625rem]"} />
            </div>
          </div>
        </section>
      );
    }
    case "fit": {
      if (block.yes.length === 0 && block.no.length === 0) return null;
      const w = blockWords(ctx.lang ?? DEFAULT_LANGUAGE);
      const both = block.yes.length > 0 && block.no.length > 0;
      return (
        <section className="sp-section">
          <Heading text={block.heading} />
          <div className={`sp-fit ${both ? "sp-fit-2" : ""} ${block.heading ? "mt-5" : ""}`}>
            {block.yes.length ? (
              <div className="sp-fit-side sp-fit-yes">
                <h3 className="text-lg font-bold">{block.yesLabel || w.fitYes}</h3>
                <ul>
                  {block.yes.map((item, i) => (
                    <li key={i}>
                      <span className="sp-fit-mark" aria-hidden="true">
                        <Icon name="check" size={14} strokeWidth={2.6} />
                      </span>
                      <span className="font-semibold">{item}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            {block.no.length ? (
              <div className="sp-fit-side sp-fit-no">
                <h3 className="text-lg font-bold">{block.noLabel || w.fitNo}</h3>
                <ul>
                  {block.no.map((item, i) => (
                    <li key={i}>
                      <span className="sp-fit-mark" aria-hidden="true">
                        <Icon name="close" size={14} strokeWidth={2.6} />
                      </span>
                      <span>{item}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </div>
        </section>
      );
    }
    case "steps": {
      if (block.items.length === 0) return null;
      const w = blockWords(ctx.lang ?? DEFAULT_LANGUAGE);
      return (
        <section className="sp-section">
          <Heading text={block.heading} />
          <ol className={`sp-steps ${block.heading ? "mt-5" : ""}`}>
            {block.items.map((item, i) => (
              <li key={i} className="sp-step">
                <span className="sp-number" aria-hidden="true">
                  {i + 1}
                </span>
                <span className="sp-step-body">
                  <span className="sr-only">{`${w.stepN(i + 1)}: `}</span>
                  <span className="block font-semibold leading-snug">{item.title}</span>
                  {item.detail ? <span className="st-muted mt-1 block whitespace-pre-line text-[0.9375rem] leading-relaxed">{item.detail}</span> : null}
                </span>
              </li>
            ))}
          </ol>
        </section>
      );
    }
    case "compare": {
      if (block.rows.length === 0) return null;
      const w = blockWords(ctx.lang ?? DEFAULT_LANGUAGE);
      const first = block.columnA || ctx.productTitle;
      const second = block.columnB || w.compareOther;
      return (
        <section className="sp-section">
          <Heading text={block.heading} />
          <div className={`sp-compare ${block.heading ? "mt-5" : ""}`}>
            <table>
              <thead>
                <tr>
                  <td aria-hidden="true" />
                  <th scope="col" className="sp-compare-ours">{first}</th>
                  <th scope="col" className="sp-compare-other">{second}</th>
                </tr>
              </thead>
              <tbody>
                {block.rows.map((row, i) => (
                  <tr key={i}>
                    <th scope="row">{row.label}</th>
                    <td className="sp-compare-ours">
                      <Cell text={row.a} ours ctx={ctx} />
                    </td>
                    <td className="sp-compare-other">
                      <Cell text={row.b} ours={false} ctx={ctx} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      );
    }
    case "bonuses": {
      if (block.items.length === 0) return null;
      const w = blockWords(ctx.lang ?? DEFAULT_LANGUAGE);
      return (
        <section className="sp-section">
          <Heading text={block.heading} />
          <ul className={`sp-bonuses ${block.items.length > 1 ? "sp-bonuses-2" : ""} ${block.heading ? "mt-5" : ""}`}>
            {block.items.map((item, i) => (
              <li key={i} className="sp-bonus">
                <span className="sp-bonus-icon" aria-hidden="true">
                  <Icon name="gift" size={20} />
                </span>
                <span className="min-w-0">
                  <span className="sp-bonus-number">{w.bonusN(i + 1)}</span>
                  <span className="mt-0.5 block font-semibold leading-snug">{item.title}</span>
                  {item.detail ? <span className="st-muted mt-1 block whitespace-pre-line text-[0.9375rem] leading-relaxed">{item.detail}</span> : null}
                </span>
              </li>
            ))}
          </ul>
        </section>
      );
    }
    case "quotes": {
      // Others' words, kept as they said them, each with the link to where it was said (lib/sales-page.ts, QuotesBlock).
      if (block.items.length === 0) return null;
      const w = blockWords(ctx.lang ?? DEFAULT_LANGUAGE);
      return (
        <section className="sp-section">
          <Heading text={block.heading} />
          <ul className={`sp-quotes ${block.items.length > 1 ? "sp-quotes-2" : ""} ${block.heading ? "mt-5" : ""}`}>
            {block.items.map((item, i) => {
              const host = quoteHost(item.url);
              return (
                <li key={i}>
                  <figure className="sp-quote">
                    <span className="sp-quote-mark" aria-hidden="true">
                      <Icon name="quote" size={22} />
                    </span>
                    <blockquote cite={item.url} className="whitespace-pre-line leading-relaxed">
                      {item.text}
                    </blockquote>
                    <figcaption className="sp-quote-by">
                      {item.name ? <span className="font-semibold">{item.name}</span> : null}
                      {ctx.preview ? (
                        // In the studio's preview a press opens the block, so it is not a link there.
                        <span className="sp-quote-link">
                          {w.quoteSource(host)}
                          <Icon name="arrow-up-right" size={14} />
                        </span>
                      ) : (
                        <a href={item.url} target="_blank" rel="noopener noreferrer nofollow ugc" className="sp-quote-link">
                          {w.quoteSource(host)}
                          <Icon name="arrow-up-right" size={14} />
                        <NewTab /></a>
                      )}
                    </figcaption>
                  </figure>
                </li>
              );
            })}
          </ul>
        </section>
      );
    }
    case "product": {
      const card = block.product ? ctx.featured?.[block.product] : undefined;
      if (!card) return null;
      const w = blockWords(ctx.lang ?? DEFAULT_LANGUAGE);
      const inner = (
        <>
          {card.picture ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={card.picture.src} alt="" width={card.picture.width} height={card.picture.height} loading="lazy" decoding="async" className="sp-product-picture" />
          ) : null}
          <span className="sp-product-words">
            <span className="sp-product-title">{card.title}</span>
            {card.summary ? <span className="st-muted sp-product-summary">{card.summary}</span> : null}
            <span className="sp-product-foot">
              <span className="st-price text-sm">{card.pill}</span>
              <span className="sp-product-go">
                {w.productLink}
                <Icon name="arrow-right" size={16} />
              </span>
            </span>
          </span>
        </>
      );
      return (
        <section className="sp-section">
          <Heading text={block.heading} />
          {block.note ? <PlainText text={block.note} preview={ctx.preview} className="st-muted mt-2" /> : null}
          <div className={block.heading || block.note ? "mt-5" : ""}>
            {ctx.preview ? <div className="sp-product">{inner}</div> : <a href={card.href} className="sp-product">{inner}</a>}
          </div>
        </section>
      );
    }
    case "form": {
      const form = block.form ? ctx.forms?.[block.form] : undefined;
      if (!form) return null;
      return <FormView block={block} form={form} ctx={ctx} />;
    }
    case "facts": {
      // Only numbers the store counted, and only those the creator chose; none, and the block is not drawn.
      const shown = block.show.map((key) => ctx.facts?.[key]).filter((fact): fact is NonNullable<typeof fact> => Boolean(fact));
      if (shown.length === 0) return null;
      const w = blockWords(ctx.lang ?? DEFAULT_LANGUAGE);
      return (
        <section className="sp-section">
          <Heading text={block.heading} />
          <dl className={`sp-facts sp-facts-${Math.min(shown.length, 4)} ${block.heading ? "mt-5" : ""}`}>
            {shown.map((fact) => (
              <div key={fact.key} className="sp-fact">
                <dt className="sr-only">{fact.label}</dt>
                <dd>
                  <span className="sp-fact-value">
                    {fact.value}
                    {fact.key === "rating" ? <span className="sr-only">{` ${w.outOfFive}`}</span> : null}
                  </span>
                  <span className="sp-fact-label" aria-hidden="true">
                    {fact.key === "rating" ? `${w.outOfFive} · ${fact.label}` : fact.label}
                  </span>
                </dd>
              </div>
            ))}
          </dl>
        </section>
      );
    }
    case "countdown":
      // One that was never given its moment, or whose moment has passed, is not drawn.
      if (!block.until || (ctx.now !== undefined && block.until <= ctx.now)) return null;
      return (
        <section className="sp-section">
          <Countdown
            until={block.until}
            now={ctx.now}
            heading={block.heading}
            note={block.note}
            words={{
              units: wordsIn(ctx.lang ?? DEFAULT_LANGUAGE).countdownUnits,
              until: wordsIn(ctx.lang ?? DEFAULT_LANGUAGE).until("{when}"),
              locale: LANGUAGES[ctx.lang ?? DEFAULT_LANGUAGE].locale,
            }}
          />
        </section>
      );
  }
}

/**
 * The blocks below the hero, each in its own wrapper, in the page's style
 * (lib/sales-page.ts, PageStyle). A block with nothing to show takes no place
 * at all, so the bands of a page set in bands still alternate on what the
 * reader sees. The wrapper carries the block's id, for how far down the page
 * was read (components/page-depth.tsx).
 */
export function PageSections({
  blocks,
  ctx,
  style,
  reviewsFor,
}: {
  blocks: PageBlock[];
  ctx: BlockContext;
  style: PageStyle;
  /** What stands where the reviews block is, under its heading. */
  reviewsFor: (heading: string) => ReactNode;
}) {
  const shown: { block: PageBlock; view: ReactNode }[] = [];
  for (const block of blocks) {
    // BlockView holds no state, so asking it here is drawing it once.
    const view = BlockView({ block, ctx, reviews: block.kind === "reviews" ? reviewsFor(block.heading) : null });
    if (view !== null) shown.push({ block, view });
  }
  const bands = bandsOf(style, shown.map(({ block }) => block));
  return (
    <>
      {shown.map(({ block, view }, index) => {
        const classes = [
          "sp-block",
          bands[index].phone ? "sp-band-phone" : "",
          bands[index].computer ? "sp-band-computer" : "",
          block.screens ? `sp-only-${block.screens}` : "",
        ];
        return (
          <div key={block.id} data-block={block.id} className={classes.filter(Boolean).join(" ")}>
            {view}
          </div>
        );
      })}
    </>
  );
}

/** One question of a form, drawn as the browser's own controls, so it works with JavaScript off. */
function FormQuestion({ field, form, ctx }: { field: FormField; form: FormDef; ctx: BlockContext }) {
  const w = formWords(ctx.lang ?? DEFAULT_LANGUAGE);
  const id = `f-${form.id}-${field.id}`;
  const name = `q_${field.id}`;
  const label = (
    <>
      {field.label}
      {field.required ? <span className="st-muted text-sm font-normal">{` (${w.required})`}</span> : null}
    </>
  );
  if (field.type === "choice" || field.type === "choices" || field.type === "scale") {
    const options = field.type === "scale" ? Array.from({ length: 10 }, (_, i) => ({ id: String(i + 1), label: String(i + 1) })) : field.options;
    const many = field.type === "choices";
    return (
      <fieldset className="sp-form-field" data-field={field.id}>
        <legend className="st-label">{label}</legend>
        <div className={field.type === "scale" ? "sp-form-scale" : "sp-form-options"}>
          {options.map((option, i) => (
            <label key={option.id} className="sp-form-option">
              <input
                type={many ? "checkbox" : "radio"}
                name={name}
                value={option.id}
                required={!many && field.required && i === 0}
                disabled={ctx.preview}
              />
              <span>{option.label}</span>
            </label>
          ))}
        </div>
      </fieldset>
    );
  }
  return (
    <div className="sp-form-field" data-field={field.id}>
      <label htmlFor={id} className="st-label">
        {label}
      </label>
      {field.type === "long" ? (
        <textarea id={id} name={name} rows={4} maxLength={MAX_LONG_ANSWER} required={field.required} disabled={ctx.preview} className="st-field" />
      ) : (
        <input
          id={id}
          name={name}
          type={field.type === "email" ? "email" : "text"}
          autoComplete={field.type === "email" ? "email" : "off"}
          maxLength={field.type === "email" ? 254 : MAX_SHORT_ANSWER}
          required={field.required}
          disabled={ctx.preview}
          className="st-field"
        />
      )}
    </div>
  );
}

/** A form, survey or quiz on one of the store's own pages (lib/forms.ts). */
function FormView({ block, form, ctx }: { block: Extract<PageBlock, { kind: "form" }>; form: FormDef; ctx: BlockContext }) {
  const w = formWords(ctx.lang ?? DEFAULT_LANGUAGE);
  // Before it opens or after it closes (639 [GL7](26)), the page says so instead of asking; the studio's preview always shows it.
  const taking = ctx.now === undefined ? "open" : formOpen(form, ctx.now);
  if (taking !== "open") {
    return (
      <section className="sp-section" id={`form-${form.id}`}>
        <Heading text={block.heading} />
        <p className="st-muted mt-4" role="status">
          {taking === "not_yet" && form.opensAt ? w.notYet(scheduleWhen(form.opensAt, ctx.lang ?? DEFAULT_LANGUAGE)) : w.ended}
        </p>
      </section>
    );
  }
  const notice = ctx.formNotice?.form === form.id ? ctx.formNotice.status : "";
  const problem = notice && notice in w.errors ? w.errors[notice as keyof typeof w.errors] : "";
  const target = ctx.formTarget;
  return (
    <section className="sp-section" id={`form-${form.id}`}>
      <Heading text={block.heading} />
      {problem ? (
        <p className="notice notice-error mt-4" role="alert">
          {problem}
        </p>
      ) : null}
      <form action="/api/store/form" method="post" className={`sp-form ${block.heading ? "mt-5" : ""}`}>
        {target ? (
          <>
            <input type="hidden" name="handle" value={target.handle} />
            <input type="hidden" name="page" value={target.page} />
            {target.funnel ? <input type="hidden" name="f" value={target.funnel} /> : null}
          </>
        ) : null}
        <input type="hidden" name="form" value={form.id} />
        <div aria-hidden="true" className="hidden">
          <label>
            Leave this empty
            <input type="text" name="website" tabIndex={-1} autoComplete="off" />
          </label>
        </div>
        {form.fields.map((field) => (
          <FormQuestion key={field.id} field={field} form={form} ctx={ctx} />
        ))}
        {/* Only what the branching needs reaches the browser: a scored quiz's points and ranges stay on the server. */}
        {branches(form) && !ctx.preview ? <FormBranching form={{ id: form.id, fields: form.fields.map((f) => ({ ...f, options: f.options.map(({ id, label, outcome, next }) => ({ id, label, outcome, ...(next ? { next } : {}) })) })), outcomes: form.outcomes.map(({ id, title, body, product }) => ({ id, title, body, product })) }} /> : null}
        {/* A long form can be finished later: its answers kept in the visitor's own browser, only if they ask (639 [GL7](26)). */}
        {offersKeep(form) && !ctx.preview && target ? <FormKeep handle={target.handle} form={form.id} words={w} /> : null}
        {form.offerList && target?.listOpen ? (
          <label className="sp-form-option">
            <input type="checkbox" name="consent" value="yes" disabled={ctx.preview} />
            <span className="text-sm">{w.hearFrom(ctx.storeName)}</span>
          </label>
        ) : null}
        <button type={ctx.preview ? "button" : "submit"} className="btn st-btn btn-lg mt-2 self-start">
          {form.button || w.send}
        </button>
      </form>
    </section>
  );
}

