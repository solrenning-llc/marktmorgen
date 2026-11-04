import { TrustChecks } from "@/components/trust-checks";
import Link from "next/link";
import { RevealOnScroll } from "@/components/home-parts";
import { Icon, iconFor } from "@/components/icons";
import { SiteFooter } from "@/components/site-footer";
import { SiteNav } from "@/components/site-nav";
import { FeatureVisual } from "@/components/feature-visuals";
import { JsonLd } from "@/components/structured-data";
import { PAGES, type Block, type TopicPage } from "@/lib/site-pages";
import { PUBLISHED_PLAN_PRICES as PLAN_PRICES, PLAN_TITLES, TRIAL_DAYS } from "@/lib/plan";
import { PLANS_ON_SALE, startWords } from "@/lib/opening";
import { feeWords } from "@/lib/fee-words";

const PHOTO = (id: string) =>
  `https://images.unsplash.com/${id}?auto=format&fit=crop&crop=faces&w=160&h=160&q=72`;

/** The same source, cropped to a landscape frame rather than to a face. */
const PHOTO_WIDE = (id: string, w: number, h: number) =>
  `https://images.unsplash.com/${id}?auto=format&fit=crop&w=${w}&h=${h}&q=72`;

const BADGE_CLASS = {
  live: "tag tag-live",
  building: "tag tag-next",
  proof: "tag tag-brand",
} as const;

const dollars = (cents: number) => `$${(cents / 100).toLocaleString("en-US", { maximumFractionDigits: 2 })}`;

const PLAN_LINE = {
  creator: "All plans; limits apply",
  pro: `${PLAN_TITLES.pro} and ${PLAN_TITLES.scale}`,
} as const;

/** A heading id from its words, so a section can be linked to. */
function sectionId(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);
}

function StoreCard({ block, hero = false }: { block: Extract<Block, { kind: "storecard" }>; hero?: boolean }) {
  return (
    <div className="overflow-hidden rounded-[var(--r-xl)] border border-line bg-white text-ink shadow-[var(--shadow-md)]">
      <div className="flex items-center gap-4 border-b border-line bg-paper p-5 sm:p-6">
        {block.photo ? (
          // Direct delivery keeps the existing no-image-optimizer cost model.
          // eslint-disable-next-line @next/next/no-img-element
          <img src={PHOTO(block.photo)} alt={block.alt} width={64} height={64} loading={hero ? "eager" : "lazy"} className="h-16 w-16 rounded-full bg-sand-deep object-cover" />
        ) : (
          <div aria-hidden="true" className="flex h-16 w-16 shrink-0 items-center justify-center rounded-full bg-sand-deep"><Icon name="store" size={28} /></div>
        )}
        <div className="min-w-0">
          <p className="text-lg font-semibold text-ink">{block.creator}</p>
          <p className="text-ink-soft">{block.tagline}</p>
        </div>
      </div>
      <ul className="divide-y divide-line">
        {block.items.map((item) => (
          <li key={item.label} className="flex items-center justify-between gap-4 px-5 py-3.5 sm:px-6">
            <span className="min-w-0">
              <span className="block font-medium text-ink">{item.label}</span>
              <span className="block text-sm text-ink-soft">{item.detail}</span>
            </span>
            <span className="shrink-0 rounded-[8px] bg-lilac px-2.5 py-1 text-sm font-semibold text-violet-deep">{item.price}</span>
          </li>
        ))}
      </ul>
      <p className="flex items-start gap-2 border-t border-line bg-paper px-5 py-3 text-sm text-ink-soft sm:px-6">
        <Icon name="info" size={16} className="mt-0.5 shrink-0" />
        <span>
          {block.example ?? (block.creator === "Harbor Kitchen"
            ? "The live demo store. Jenny is a fictional cook; the checkout is a real Stripe checkout in test mode, and the files are real."
            : `An example: ${block.creator} is an invented creator, and every product type shown works today.`)}
        </span>
      </p>
    </div>
  );
}

function BlockView({ block }: { block: Block }) {
  switch (block.kind) {
    case "lead":
      return <p className="t-lead measure-wide text-ink-soft">{block.text}</p>;

    case "cards":
      return (
        <section className="" aria-labelledby={sectionId(block.title)}>
          <h2 id={sectionId(block.title)} className="t-section">{block.title}</h2>
          <div className="mt-6 grid gap-4 sm:grid-cols-2">
            {block.items.map((item) => (
              <article key={item.title} className="card p-6">
                <span className="icon-tile">
                  <Icon name={iconFor(item.emoji)} size={22} />
                </span>
                <h3 className="mt-5 text-[1.0625rem] font-semibold text-ink">{item.title}</h3>
                <p className="mt-2 text-[0.9375rem] text-ink-soft">{item.body}</p>
              </article>
            ))}
          </div>
        </section>
      );

    case "how":
      return (
        <section className="" aria-labelledby={sectionId(block.title)}>
          <h2 id={sectionId(block.title)} className="t-section">{block.title}</h2>
          <ol className="mt-6 grid gap-4 md:grid-cols-3">
            {block.items.map((item, i) => (
              <li key={item.title} className="card-flat relative p-6">
                <span className="grid h-9 w-9 place-items-center rounded-full bg-violet-brand text-sm font-semibold text-white">
                  {i + 1}
                </span>
                <h3 className="mt-4 font-semibold text-ink">{item.title}</h3>
                <p className="mt-1.5 text-[0.9375rem] text-ink-soft">{item.body}</p>
              </li>
            ))}
          </ol>
        </section>
      );

    case "features":
      return (
        <section className="" aria-labelledby={sectionId(block.title)}>
          <h2 id={sectionId(block.title)} className="t-section">{block.title}</h2>
          {block.intro ? <p className="mt-3 max-w-2xl text-ink-soft">{block.intro}</p> : null}
          <ul className="mt-6 grid gap-4 sm:grid-cols-2">
            {block.items.map((item) => {
              const inner = (
                <>
                  <span className="icon-tile icon-tile-sm">
                    <Icon name={item.icon} size={18} />
                  </span>
                  <span className="min-w-0">
                    <span className="flex items-center gap-1.5 font-semibold text-ink">
                      {item.title}
                      {item.href ? <Icon name="arrow-right" size={15} className="arrow text-violet-deep" /> : null}
                    </span>
                    <span className="mt-1 block text-[0.9375rem] text-ink-soft [overflow-wrap:anywhere]">{item.body}</span>
                  </span>
                </>
              );
              return (
                <li key={item.title}>
                  {item.href ? (
                    <Link href={item.href} className="card flex h-full gap-4 p-5 transition-shadow hover:shadow-[var(--shadow-md)]">
                      {inner}
                    </Link>
                  ) : (
                    <div className="card flex h-full gap-4 p-5">{inner}</div>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      );

    case "uses":
      return (
        <section className="" aria-labelledby={sectionId(block.title)}>
          <h2 id={sectionId(block.title)} className="t-section">{block.title}</h2>
          <ul className="mt-6 grid gap-4 md:grid-cols-3">
            {block.items.map((item) => (
              <li key={item.who} className="rounded-[var(--r-lg)] bg-sand p-6">
                <Icon name={item.icon} size={22} className="text-violet-deep" />
                <h3 className="mt-3 font-semibold text-ink">{item.who}</h3>
                <p className="mt-1.5 text-[0.9375rem] text-ink-soft">{item.what}</p>
              </li>
            ))}
          </ul>
        </section>
      );

    case "limits":
      return (
        <section className="rounded-[var(--r-lg)] border border-line bg-white p-6 sm:p-8" aria-labelledby={sectionId(block.title)}>
          <h2 id={sectionId(block.title)} className="t-h3 flex items-center gap-2 text-ink">
            <Icon name="info" size={20} className="text-violet-deep" />
            {block.title}
          </h2>
          {block.intro ? <p className="mt-2 text-ink-soft">{block.intro}</p> : null}
          <ul className="mt-5 grid gap-3">
            {block.items.map((item) => (
              <li key={item} className="flex gap-3 text-[0.9375rem] text-ink-soft [overflow-wrap:anywhere]">
                <span className="mt-[0.55rem] h-1.5 w-1.5 shrink-0 rounded-full bg-ink-mute" aria-hidden="true" />
                <span>{item}</span>
              </li>
            ))}
          </ul>
        </section>
      );

    case "faq":
      return (
        <section className="" aria-labelledby={sectionId(block.title)}>
          <h2 id={sectionId(block.title)} className="t-section">{block.title}</h2>
          <div className="mt-6 divide-y divide-line overflow-hidden rounded-[var(--r-lg)] border border-line bg-white">
            {block.items.map((item) => (
              <details key={item.q} className="group">
                {/* A native summary, so its open or closed state is announced; a plus when closed and a minus when open, both decorative, with no movement, and the focus ring drawn inside, since the rounded box clips what is outside (534 [FQ1] (i)). */}
                <summary className="flex min-h-11 cursor-pointer focus-visible:[outline-offset:-3px]! list-none items-center justify-between gap-4 px-5 py-4 font-semibold text-ink sm:px-6 [&::-webkit-details-marker]:hidden">
                  {item.q}
                  <Icon name="plus" size={18} className="shrink-0 text-violet-deep group-open:hidden" />
                  <Icon name="minus" size={18} className="hidden shrink-0 text-violet-deep group-open:block" />
                </summary>
                <p className="px-5 pb-5 text-[0.9375rem] text-ink-soft sm:px-6">{item.a}</p>
              </details>
            ))}
          </div>
        </section>
      );

    case "ladder":
      return (
        <section className="" aria-labelledby={sectionId(block.title)}>
          <h2 id={sectionId(block.title)} className="t-section">{block.title}</h2>
          {block.intro ? <p className="mt-3 max-w-2xl text-ink-soft">{block.intro}</p> : null}
          <ol className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {block.items.map((item) => (
              <li key={item.title}>
                <Link href={item.href} className="card group flex h-full flex-col p-5 transition-shadow hover:shadow-[var(--shadow-md)]">
                  <span className="flex items-center justify-between gap-3">
                    <span className="text-[0.8125rem] font-semibold uppercase tracking-[0.12em] text-ink-mute">{`Step ${item.step}`}</span>
                    <span className="icon-tile icon-tile-sm">
                      <Icon name={item.icon} size={18} />
                    </span>
                  </span>
                  <span className="mt-4 block font-semibold text-ink">{item.title}</span>
                  <span className="mt-1 block text-[1.25rem] font-semibold tracking-[-0.02em] text-violet-deep">{item.price}</span>
                  <span className="mt-2 block flex-1 text-[0.9375rem] text-ink-soft">{item.body}</span>
                  <span className="mt-4 inline-flex items-center gap-1 text-sm font-semibold text-violet-deep">
                    How it works
                    <Icon name="arrow-right" size={15} className="transition-transform group-hover:translate-x-0.5" />
                  </span>
                </Link>
              </li>
            ))}
          </ol>
        </section>
      );

    case "steps":
      return (
        <section className="" aria-labelledby={sectionId(block.title)}>
          <h2 id={sectionId(block.title)} className="t-section">{block.title}</h2>
          <ol className="mt-6 grid gap-3">
            {block.items.map((item, i) => (
              <li key={item.title} className="card-flat flex gap-4 p-5 sm:p-6">
                <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-lilac text-sm font-semibold text-violet-deep">
                  {i + 1}
                </span>
                <span>
                  <span className="block font-semibold text-ink">{item.title}</span>
                  <span className="mt-1 block text-[0.9375rem] text-ink-soft">{item.body}</span>
                </span>
              </li>
            ))}
          </ol>
        </section>
      );

    case "facts":
      return (
        <section className="" aria-labelledby={sectionId(block.title)}>
          <h2 id={sectionId(block.title)} className="t-section">{block.title}</h2>
          <div className="mt-6 grid gap-4 sm:grid-cols-3">
            {block.items.map((item, i) => (
              <div key={item.label} className={i === 0 ? "rounded-[var(--r-lg)] bg-night p-6 text-white" : "card-flat p-6"}>
                <p className={`text-[2.5rem] font-semibold leading-none tracking-[-0.04em] ${i === 0 ? "text-white" : "text-ink"}`}>
                  {item.value}
                </p>
                <p className={`mt-3 text-[0.9375rem] ${i === 0 ? "text-white/70" : "text-ink-soft"}`}>{item.label}</p>
              </div>
            ))}
          </div>
        </section>
      );

    case "table":
      return (
        <section className="" aria-labelledby={sectionId(block.title)}>
          <h2 id={sectionId(block.title)} className="t-section">{block.title}</h2>
          <div className="mt-6 hidden overflow-hidden rounded-[var(--r-lg)] border border-line bg-white shadow-[var(--shadow-sm)] sm:block">
            <table className="table-clean text-[0.9375rem]">
              <thead>
                <tr>
                  {block.head.map((cell, i) => (
                    <th key={cell + i} scope="col" className={i === 2 ? "!text-violet-deep" : ""}>
                      {cell || <span className="sr-only">Row</span>}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {block.rows.map((row) => (
                  <tr key={row[0]}>
                    <th scope="row" className="w-[34%] font-semibold text-ink">
                      {row[0]}
                    </th>
                    <td className="text-ink-soft">{row[1]}</td>
                    <td className="bg-lilac/40 font-medium text-ink">{row[2]}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <ul className="mt-6 grid gap-3 sm:hidden">
            {block.rows.map((row) => (
              <li key={row[0]} className="card-flat p-5">
                <p className="font-semibold text-ink">{row[0]}</p>
                <dl className="mt-3 grid gap-2 text-[0.9375rem]">
                  <div className="flex gap-3">
                    <dt className="w-28 shrink-0 text-ink-mute">{block.head[1]}</dt>
                    <dd className="text-ink-soft">{row[1]}</dd>
                  </div>
                  <div className="flex gap-3">
                    <dt className="w-28 shrink-0 font-semibold text-violet-deep">{block.head[2]}</dt>
                    <dd className="font-medium text-ink">{row[2]}</dd>
                  </div>
                </dl>
              </li>
            ))}
          </ul>
          {block.note && <p className="mt-3 text-sm text-ink-mute">{block.note}</p>}
        </section>
      );

    case "quote":
      return (
        <figure className="border-l-[3px] border-violet-brand py-1 pl-6">
          <blockquote className="text-[1.35rem] font-medium leading-snug tracking-[-0.02em] text-ink">
            {block.text}
          </blockquote>
          <figcaption className="mt-3 text-[0.9375rem] text-ink-mute">{block.source}</figcaption>
        </figure>
      );

    case "note":
      return (
        <section className="rounded-[var(--r-lg)] border border-line bg-sand p-6">
          <h2 className="flex items-center gap-2 font-semibold text-ink">
            <Icon name="info" size={18} className="text-violet-deep" />
            {block.title}
          </h2>
          <p className="mt-2 text-[0.9375rem] text-ink-soft">{block.body}</p>
        </section>
      );

    case "storecard":
      return (
        <section className="" aria-labelledby={sectionId(block.title)}>
          <h2 id={sectionId(block.title)} className="t-section">{block.title}</h2>
          <div className="mt-6">
            <StoreCard block={block} />
          </div>
        </section>
      );
  }
}

/** The questions on a page, in the form search engines read. */
function FaqData({ blocks }: { blocks: Block[] }) {
  const items = blocks.flatMap((b) => (b.kind === "faq" ? b.items : []));
  if (items.length === 0) return null;
  const data = {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: items.map((item) => ({
      "@type": "Question",
      name: item.q,
      acceptedAnswer: { "@type": "Answer", text: item.a },
    })),
  };
  return <JsonLd data={data} />;
}

function Related({ slugs }: { slugs: string[] }) {
  const pages = slugs
    .map((slug) => PAGES.find((p) => p.section === "platform" && p.slug === slug))
    .filter((p): p is TopicPage => Boolean(p && p.menu));
  if (pages.length === 0) return null;
  return (
    <section aria-labelledby="related-title" className="border-t border-line bg-white">
      <div className="container-page max-w-[64rem]! py-14 sm:py-16">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <h2 id="related-title" className="t-section">Works well with</h2>
          <Link href="/platform" className="link-arrow text-sm">
            Every feature
            <Icon name="arrow-right" size={16} className="arrow" />
          </Link>
        </div>
        <ul className="mt-6 grid gap-3 sm:grid-cols-2">
          {pages.map((p) => (
            <li key={p.slug}>
              <Link href={`/platform/${p.slug}`} className="flex h-full items-start gap-3 rounded-[var(--r-md)] border border-line p-4 transition-colors hover:bg-paper">
                <span className="icon-tile icon-tile-sm">
                  <Icon name={p.menu!.icon} size={18} />
                </span>
                <span className="min-w-0">
                  <span className="flex flex-wrap items-center gap-2 font-semibold text-ink">
                    {p.menu!.label}
                    {p.plan === "pro" ? <span className="tag tag-brand">Pro</span> : null}
                  </span>
                  <span className="mt-0.5 block text-sm text-ink-soft">{p.menu!.description}</span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

/*
 * What the page covers, beside its own heading.
 *
 * The comparison pages carry no screenshot, and a heading with half a screen
 * of empty space next to it is the part of a site that looks unfinished. This
 * is the index of the page itself, read from the blocks below, so the space is
 * filled by something a visitor actually wants: how long this is, what is in
 * it, and a way straight to the row they came for.
 */
/*
 * The list of the page's sections, beside the heading when there is no
 * drawing to show there. It is drawn for the dark opening of the evidence
 * pages, and for the daylight opening of a feature page that has no drawing
 * of its own yet, where white text would disappear into the background.
 */
function HeroContents({ blocks, light = false }: { blocks: Block[]; light?: boolean }) {
  const titles = blocks
    .map((b) => ("title" in b && typeof b.title === "string" ? b.title : null))
    .filter((t): t is string => Boolean(t))
    .slice(0, 6);
  if (titles.length < 2) return null;
  return (
    <div
      className={`rounded-[var(--r-lg)] border p-6 sm:p-7 ${
        light ? "border-line bg-white shadow-[var(--shadow-sm)]" : "border-white/14 bg-white/[0.05] backdrop-blur-sm"
      }`}
    >
      <p className={`text-[0.75rem] font-semibold uppercase tracking-[0.14em] ${light ? "text-ink-mute" : "text-white/70"}`}>
        On this page
      </p>
      <ol className="mt-4 grid gap-1">
        {titles.map((t, i) => (
          <li key={t}>
            <a
              href={`#${sectionId(t)}`}
              className={`flex min-h-11 items-baseline gap-3 rounded-[10px] px-2 py-2 text-[0.9375rem] transition-colors ${
                light ? "text-ink-soft hover:bg-paper hover:text-ink" : "text-white/80 hover:bg-white/10 hover:text-white"
              }`}
            >
              <span className={`w-4 shrink-0 text-[0.75rem] font-semibold tabular-nums ${light ? "text-violet-deep" : "text-white/70"}`}>
                {i + 1}
              </span>
              <span>{t}</span>
            </a>
          </li>
        ))}
      </ol>
    </div>
  );
}

export function TopicPageView({ page }: { page: TopicPage }) {
  // A creator page shows its example store beside the heading, where a
  // feature page shows the drawing of its screen.
  const heroStore = page.section === "for" && page.blocks[0]?.kind === "storecard" ? page.blocks[0] : null;
  const blocks = heroStore ? page.blocks.slice(1) : page.blocks;
  const pro = page.plan === "pro";
  /* A page with a drawing or a store card beside it reads wide; an argument
     made of tables and paragraphs reads at a column a person can follow. */
  const wide = Boolean(page.visual || heroStore);

  /*
   * Three sections, three openings.
   *
   * A feature page opens in daylight, because its whole job is to let you
   * read a screenshot; the creator pages stay dark, because a photograph of
   * somebody at work carries further against it; the evidence pages take the
   * steady navy rather than the home page's one dramatic dark, so that
   * reading four of them in a row does not feel like four launches. Before
   * this, every page on the site opened with the same violet-black band, and
   * the tenth one looked exactly like the first.
   */
  const light = page.section === "platform";

  return (
    <div className="flex min-h-screen flex-col bg-paper text-ink">
      <RevealOnScroll />
      <SiteNav />

      <main id="content" className="flex-1">
        <section
          className={
            light
              ? "surface-dawn overflow-hidden border-b border-line"
              : "surface-navy nb-grid-lines overflow-hidden"
          }
        >
          {/*
            min-w-0 on both columns, and it is not decoration. A grid item
            defaults to min-width:auto, so a column cannot shrink below the
            widest thing in it — and the illustration on the right has an
            intrinsic width of 410px. On a 375px phone that dragged the whole
            implicit column to 410px, the heading and this paragraph with it,
            and the section's own overflow-hidden then quietly cut the words
            off at the screen edge instead of letting them wrap. Measured, not
            guessed: 409.663px of column inside a 342.69px container.
          */}
          <div className="container-page grid items-center gap-12 py-14 sm:py-20 lg:grid-cols-[1.05fr_0.95fr] lg:gap-16">
            <div className={`min-w-0 ${light ? "" : "on-dark"}`}>
              <p className="eyebrow ">{page.eyebrow}</p>
              {/*
                The expressive face carries a few words, never a clause. Set a
                long phrase in italic serif at heading size and it stops being
                emphasis: it becomes a second, harder-to-read heading. Past a
                short phrase the highlight keeps the heading's own face and is
                separated by colour alone.
              */}
              <h1 className={`t-h1 balance mt-5 ${light ? "text-ink" : "text-white"}`}>
                {page.title}{" "}
                <span
                  className={`${page.highlight.length <= 26 ? "serif font-normal" : ""} ${
                    light ? "text-violet-deep" : "text-[#cfc4ff]"
                  }`}
                >
                  {page.highlight}
                </span>
              </h1>
              <p
                className={`t-lead mt-6 max-w-2xl ${light ? "text-ink-soft" : "text-white/80"}`}
              >
                {page.intro}
              </p>
              <p className="mt-7 flex flex-wrap items-center gap-2">
                <span className={BADGE_CLASS[page.badge.tone]}>{page.badge.label}</span>
                {page.plan ? <span className="tag">{PLAN_LINE[page.plan]}</span> : null}
              </p>
              {page.section !== "proof" ? (
                <div className="mt-8 flex flex-wrap items-center gap-3">
                  <Link href="/signin" className={`btn btn-lg ${light ? "btn-primary" : "btn-light"}`}>
                    {startWords(TRIAL_DAYS)}
                    <Icon name="arrow-right" size={18} />
                  </Link>
                  <Link
                    href={pro ? "/pricing" : "/demo"}
                    className={`btn btn-lg ${light ? "btn-secondary" : "btn-outline-light"}`}
                  >
                    {pro ? "Compare the plans" : "See the live demo"}
                    <Icon name="arrow-right" size={18} />
                  </Link>
                </div>
              ) : null}
            </div>
            {page.visual ? (
              <div className="flex min-w-0 justify-center lg:justify-end">
                <FeatureVisual visual={page.visual} tone={light ? "light" : "dark"} />
              </div>
            ) : heroStore ? (
              /*
               * A photograph of the work, with the example store laid over its
               * bottom edge. The picture is there so a visitor recognises
               * themselves before they read anything; the card is there so
               * they see what the page is actually selling. Neither pretends
               * to be the other, and the line underneath says which is which.
               */
              <div className="mx-auto w-full max-w-[28rem] lg:mr-0">
                {page.photo ? (
                  // A photograph served at the sizes asked for by its own host, never through the image optimizer, which is billed per image.
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={PHOTO_WIDE(page.photo.id, 720, 540)}
                    srcSet={`${PHOTO_WIDE(page.photo.id, 560, 420)} 560w, ${PHOTO_WIDE(page.photo.id, 720, 540)} 720w, ${PHOTO_WIDE(page.photo.id, 1080, 810)} 1080w`}
                    sizes="(min-width: 1024px) 28rem, 92vw"
                    alt={page.photo.alt}
                    width={720}
                    height={540}
                    loading="eager"
                    fetchPriority="high"
                    decoding="async"
                    className="aspect-[4/3] w-full rounded-[var(--r-xl)] bg-white/10 object-cover shadow-[var(--shadow-device)]"
                  />
                ) : null}
                {/*
                  `relative` is doing real work here. The card is pulled up
                  over the photograph, and without a stacking context of its
                  own the browser paints a replaced element — the image — after
                  the backgrounds of later blocks, so the picture landed on top
                  of the card and cut the creator's name in half.
                */}
                <div className={page.photo ? "relative z-10 -mt-12 px-3 sm:-mt-14 sm:px-6" : ""}>
                  <StoreCard block={heroStore} hero />
                </div>
                {page.photo ? (
                  <p className="mt-4 text-[0.8125rem] leading-relaxed text-white/70">
                    A licensed photograph of somebody at work, not a customer of ours.
                  </p>
                ) : null}
              </div>
            ) : (
              <HeroContents blocks={blocks} light={light} />
            )}
          </div>
        </section>

        <div className={`${wide ? "container-page max-w-[64rem]!" : "container-narrow"} space-y-14 py-16 sm:space-y-16 sm:py-20`}>
          {/* A card in the heading's place moves "On this page" here, just under the top: it never goes (531 [VP1]). */}
          {page.visual ? <HeroContents blocks={blocks} light /> : null}
          {blocks.map((block, i) => (
            <BlockView key={i} block={block} />
          ))}
        </div>

        {page.section === "platform" ? <div className="container-page pb-16 sm:pb-20"><TrustChecks place="feature" /></div> : null}
        {page.related ? <Related slugs={page.related} /> : null}

        <section className="surface-sand">
          <div className="container-narrow py-16 text-center sm:py-20">
            <h2 className="t-h2 balance">{pro ? PLAN_TITLES.pro+", when you are ready for it" : "Prepare your own store"}</h2>
            <p className="mx-auto mt-4 max-w-xl text-ink-soft">
              {!PLANS_ON_SALE
                ? pro
                  ? `${PLAN_TITLES.pro} is ${dollars(PLAN_PRICES.pro.month)} a month, or ${dollars(PLAN_PRICES.pro.year)} a year, with everything on the ${dollars(PLAN_PRICES.creator.month)} plan. Paid plans are not on sale yet. You can open a store and set it up today.`
                  : `Take your address and put your first product up today. The plan is ${feeWords().planLine(dollars(PLAN_PRICES.creator.month))}, and it is not on sale yet.`
                : pro
                ? `${PLAN_TITLES.pro} is ${dollars(PLAN_PRICES.pro.month)} a month, or ${dollars(PLAN_PRICES.pro.year)} a year, with everything on the ${dollars(PLAN_PRICES.creator.month)} plan. Start on either, try it free for ${TRIAL_DAYS} days, and switch from your studio whenever you like.`
                : `Take your address, connect your own Stripe account and put your first product up. ${feeWords().planLine(dollars(PLAN_PRICES.creator.month))}, free for the first ${TRIAL_DAYS} days.`}
            </p>
            <div className="mt-8 flex flex-wrap items-center justify-center gap-x-6 gap-y-4">
              <Link href="/signin" className="btn btn-primary btn-lg">
                Start your store
                <Icon name="arrow-right" size={18} />
              </Link>
              <Link href="/demo" className="link-arrow">
                See the live demo
                <Icon name="arrow-right" size={18} className="arrow" />
              </Link>
            </div>
          </div>
        </section>
      </main>

      <FaqData blocks={blocks} />
      <SiteFooter />
    </div>
  );
}
