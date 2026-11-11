import Link from "next/link";
import { Icon } from "@/components/icons";
import type { GallerySection } from "@/lib/studio-modules";

/** The link classes the studio uses for a text link: 44px tall (WCAG 2.5.5), underlined so it is not told by color alone. */
const LINK = "inline-flex min-h-11 items-center font-semibold text-violet-deep underline underline-offset-4";

/**
 * "Add to your store" (653 [WG13], app/studio/add): every module of the
 * studio, in five groups, each card named by its module and opening the
 * module's own screen. A module the store's plan does not include says so in
 * words, with the way to the plan page where this person may open it.
 * Headings in order (one h1, an h2 per group, an h3 per card), a list per
 * group, icons hidden from screen readers, and nothing that moves.
 */
export function AddGallery({ sections }: { sections: GallerySection[] }) {
  return (
    <>
      <p className="eyebrow">Your studio</p>
      <h1 className="t-h2 mt-3">Add to your store</h1>
      <p className="mt-3 max-w-2xl text-ink-soft">
        Everything your studio can do, in groups. Each name opens that part of your studio, where you set it up.
      </p>
      {sections.map((section) => (
        <section key={section.id} aria-labelledby={`add-${section.id}`} className="mt-10">
          <h2 id={`add-${section.id}`} className="t-h3">
            {section.title}
          </h2>
          <ul className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {section.cards.map((card) => (
              <li key={card.id} className="flex min-w-0 flex-col gap-2 rounded-2xl bg-white p-4 ring-1 ring-line">
                <div className="flex items-center gap-3">
                  <span aria-hidden="true" className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-lilac text-violet-deep">
                    <Icon name={card.icon} size={18} />
                  </span>
                  <h3 className="min-w-0 text-base font-semibold text-ink [overflow-wrap:anywhere]">
                    {card.state === "open" ? (
                      <Link href={card.href} prefetch={false} className={LINK}>
                        {card.title}
                      </Link>
                    ) : (
                      card.title
                    )}
                  </h3>
                </div>
                <p className="text-sm leading-snug text-ink-soft">{card.text}</p>
                {card.state === "plan" ? (
                  <>
                    <p className="text-sm font-semibold text-ink">{`Needs the ${card.plan} plan`}</p>
                    {card.href ? (
                      <Link href={card.href} prefetch={false} className={`${LINK} text-sm`}>
                        {`See the ${card.plan} plan for ${card.title}`}
                      </Link>
                    ) : card.note ? (
                      <p className="text-sm text-ink-soft">{card.note}</p>
                    ) : null}
                  </>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ))}
    </>
  );
}
