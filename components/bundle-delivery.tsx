import type { ReactNode } from "react";
import type { Listing } from "@/lib/store";
import { linkHost } from "@/lib/product-link";
import { NewTab } from "@/components/new-tab";

/** One product of a bundle, as a buyer who paid for it opens it. */
export type BundleLine = {
  product: Pick<Listing, "id" | "title" | "link">;
  /** Where its file is downloaded from; null when it has none. */
  download: string | null;
  /** How its course is opened: a form's fields, or a plain address; null when it is not a course. */
  course: { action: string; fields: Record<string, string> } | { href: string } | null;
  /** Its licence key, drawn by the page, when it hands one out. */
  keyBox?: ReactNode;
  /**
   * The line under a link saying where it is kept, already said by the server
   * (lib/purchase-cards.ts, keptLine: the address only when short, else the
   * host only when short; null for none), as on the list of purchases. When
   * left out, the whole address is said, as on the thanks page.
   */
  kept?: string | null;
};

/**
 * Everything the list says, in the store's language
 * (lib/buyer-words/orders.ts), with the store's name already in.
 */
export type BundleWords = {
  openCourse: string;
  startCourse: string;
  openIt: string;
  /** "Open {title}": a link's or a course's button named by what it opens, where given (WCAG 2.4.9); openIt and openCourse where not. */
  openTitle?: string;
  /** "Kept on {host}: {link}". */
  keptOn: string;
  downloadIt: string;
  /** "Download {title}": a file's button named by what it downloads, where given (WCAG 2.4.9); downloadIt where not. */
  downloadTitle?: string;
  nothingAttached: string;
  /** Said when products are missing, already with how many; null when none are. */
  missing: string | null;
};

function englishWords(storeName: string, missing: number): BundleWords {
  return {
    openCourse: "Open the course",
    startCourse: "Start the course",
    openIt: "Open it",
    keptOn: "Kept on {host}: {link}",
    downloadIt: "Download it",
    nothingAttached: `This one has nothing attached right now. Reply to your order confirmation email to ask ${storeName} for it.`,
    missing:
      missing > 0
        ? `${missing === 1 ? "One product" : `${missing} products`} of this bundle ${missing === 1 ? "is" : "are"} no longer in ${storeName}'s store, so there is nothing here to open for ${missing === 1 ? "it" : "them"}. Reply to your order confirmation email and it reaches ${storeName}.`
        : null,
  };
}

/**
 * What a bundle hands over, one product after another, each with its own way
 * to open it — the same download, link or course a buyer of that product on
 * its own gets. Used by the thanks page and by the list of purchases.
 */
export function BundleDelivery({
  lines,
  missing,
  storeName,
  heading = "What is inside",
  showHeading = true,
  words: given,
}: {
  lines: BundleLine[];
  /** How many products of the bundle this store no longer has. */
  missing: number;
  storeName: string;
  heading?: string;
  /** False when the heading is already drawn above, as on the list of purchases (components/orders-bundle.tsx): it stays the list's name. */
  showHeading?: boolean;
  /** Said in the store's language; English when not given. */
  words?: BundleWords;
}) {
  const words = given ?? englishWords(storeName, missing);
  const Container = showHeading ? "section" : "div";
  return (
    <Container className="mt-6" aria-label={showHeading ? heading : undefined}>
      {showHeading ? <p className="st-label">{heading}</p> : null}
      <ul className="mt-3 space-y-3">
        {lines.map((line) => {
          const { product } = line;
          // A function, so a "$" in a title or an address is never read as a replacement pattern.
          const named = (template: string | undefined, fallback: string) => (template ? template.replace("{title}", () => product.title) : fallback);
          const kept =
            line.kept !== undefined
              ? line.kept
              : product.link
                ? words.keptOn.replace("{host}", () => linkHost(product.link as string)).replace("{link}", () => product.link as string)
                : null;
          return (
            <li key={product.id} className="rounded-2xl px-5 py-4" style={{ border: "1px solid var(--st-line)" }}>
              <p className="font-semibold">{product.title}</p>
              {line.course ? (
                "href" in line.course ? (
                  <a href={line.course.href} className="btn st-btn mt-3">
                    {named(words.openTitle, words.openCourse)}
                  </a>
                ) : (
                  <form action={line.course.action} method="post" className="mt-3">
                    {Object.entries(line.course.fields).map(([name, value]) => (
                      <input key={name} type="hidden" name={name} value={value} />
                    ))}
                    <button type="submit" className="btn st-btn">
                      {words.startCourse}
                    </button>
                  </form>
                )
              ) : product.link ? (
                <>
                  <a href={product.link} rel="noopener noreferrer nofollow" target="_blank" className="btn st-btn mt-3">
                    {named(words.openTitle, words.openIt)}
                  <NewTab /></a>
                  {kept ? <p className="st-muted mt-2 break-all text-xs">{kept}</p> : null}
                </>
              ) : line.download ? (
                <a href={line.download} className="btn st-btn mt-3">
                  {named(words.downloadTitle, words.downloadIt)}
                </a>
              ) : (
                <p className="st-muted mt-2 text-sm">{words.nothingAttached}</p>
              )}
              {line.keyBox}
            </li>
          );
        })}
      </ul>
      {missing > 0 && words.missing ? <p className="st-muted mt-3 text-sm">{words.missing}</p> : null}
    </Container>
  );
}
