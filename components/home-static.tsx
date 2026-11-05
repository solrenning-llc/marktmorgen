import Link from "next/link";
import { Icon } from "@/components/icons";
import { HOME_QUESTIONS } from "@/lib/home-faq";

// Native disclosures and a CSS-only marquee need no client component execution.
// Every answer starts closed (VS1, owner 31/10/2026); opening one closes the others (name).
export function Faq({ questions = HOME_QUESTIONS }: { questions?: typeof HOME_QUESTIONS } = {}) {
  return <ul className="divide-y divide-line border-y border-line">
    {questions.map((item,i)=><li key={item.q}>
      <details name="home-faq" className="group">
        {/* A native summary with no heading inside it (a summary is read as a button, which flattens a heading) and no ARIA over its own state (534 [FQ1] unit 43). */}
        <summary className="flex min-h-11 w-full cursor-pointer list-none items-center justify-between gap-6 py-5 text-left text-[1.0625rem] font-semibold text-ink sm:text-lg [&::-webkit-details-marker]:hidden">
          <span className="min-w-0">{item.q}</span>
          <span aria-hidden="true" className="grid h-8 w-8 shrink-0 place-items-center rounded-full border border-line text-ink-soft group-open:border-violet-brand"><Icon name="plus" size={16} className="group-open:hidden"/><Icon name="minus" size={16} className="hidden group-open:block"/></span>
        </summary>
        <div className="pb-6 pr-12">
          <p className="text-ink-soft">{item.a}</p>
          {item.links?.length?<ul className="mt-4 flex flex-wrap gap-x-5 gap-y-3">{item.links.map(link=><li key={link.href}><Link href={link.href} prefetch={false} className="link">{link.label}</Link></li>)}</ul>:null}
        </div>
      </details>
    </li>)}
  </ul>;
}

/*
 * What people sell, running past.
 *
 * Every other thing on this page is still until somebody scrolls to it.
 * This one moves on its own, continuously, because a market does — and
 * because the fastest way to answer "is this for someone like me?" is to
 * show forty things people like them sell rather than describe a
 * category.
 *
 * Each item is a real kind of product the platform delivers today: a
 * file, a course, a membership, a booked call, a bundle. Nothing here is
 * a customer, a number or a claim — it is a list of what the thing does,
 * which is why it can run without a caveat under it.
 */
/*
 * Every item carries its own photograph.
 *
 * Stan's strip is type on a tile. Theirs works; a photograph of the thing
 * works harder, because "Sourdough courses" is a category and a loaf is a
 * reason. Each id below was looked up and confirmed to resolve, and each
 * is cropped square on faces so a person in the frame is never beheaded.
 *
 * The tint is the chip's own, drawn from the five lights of the page, so
 * the strip carries the whole palette past in one pass instead of
 * repeating one accent twenty-four times.
 */
const SOLD: { label: string; photo: string }[] = [
  { label: "Meal plans", photo: "photo-1528712306091-ed0763094c98" },
  { label: "Recipe packs", photo: "photo-1556911220-e15b29be8c8f" },
  { label: "Sourdough courses", photo: "photo-1653233797467-1a528819fd4f" },
  { label: "Knife skills", photo: "photo-1518737003272-dac7c4760d5e" },
  { label: "Bread workshops", photo: "photo-1556911073-a517e752729c" },
  { label: "Batch cooking guides", photo: "photo-1636647511729-6703539ba71f" },
  { label: "Family dinner plans", photo: "photo-1606787503066-794bb59c64bc" },
  { label: "Pastry classes", photo: "photo-1556910103-1c02745aae4d" },
  { label: "Fermentation courses", photo: "photo-1592837613828-4b65deb44f15" },
  { label: "Yoga programs", photo: "photo-1676496962536-d8ef110ff6f0" },
  { label: "Mobility programs", photo: "photo-1626444232874-e72c020eeb0e" },
  { label: "Stretch routines", photo: "photo-1761971975962-9cc397e2ba2a" },
  { label: "Posture clinics", photo: "photo-1763403921315-f2ef8697199f" },
  { label: "Breathwork sessions", photo: "photo-1761971975651-4fdd4abc200f" },
  { label: "Strength plans", photo: "photo-1761971975973-cbb3e59263de" },
  { label: "Running plans", photo: "photo-1666478042293-17ea55f33b52" },
  { label: "Watercolor classes", photo: "photo-1613574714687-c33b9e90200d" },
  { label: "Brush packs", photo: "photo-1740710543611-80b658171bc3" },
  { label: "Pottery classes", photo: "photo-1649479435119-1d987ed1ae36" },
  { label: "Still life classes", photo: "photo-1655175468016-a38acfa1277b" },
  { label: "Lettering classes", photo: "photo-1613463251864-2a2bc3952817" },
  { label: "Sketchbook courses", photo: "photo-1613463639651-4aca3f3dd83e" },
  { label: "Life drawing sessions", photo: "photo-1601397210737-a5534480bdc5" },
  { label: "Lightroom presets", photo: "photo-1562577309-d67db487e6cd" },
  { label: "Font bundles", photo: "photo-1620545628446-6319bce6b95c" },
  { label: "Color theory classes", photo: "photo-1621111848501-8d3634f82336" },
  { label: "Brand kits", photo: "photo-1561070791-2526d30994b5" },
  { label: "Portfolio critiques", photo: "photo-1637270873552-80d3bb9569dd" },
  { label: "Design templates", photo: "photo-1613579917953-d35e6b72d32b" },
  { label: "Lesson plans", photo: "photo-1588873281272-14886ba1f737" },
  { label: "Study guides", photo: "photo-1619852182277-79aa23f82c8e" },
  { label: "1:1 coaching calls", photo: "photo-1616587226960-4a03badbe8bf" },
  { label: "Interview prep", photo: "photo-1673515335586-f9f662c01482" },
  { label: "Resume reviews", photo: "photo-1616587896649-79b16d8b173d" },
  { label: "Knitting patterns", photo: "photo-1544928147-79a2dbc1f389" },
  { label: "Sewing patterns", photo: "photo-1506806732259-39c2d0268443" },
  { label: "Woodworking plans", photo: "photo-1516783154360-123b392d0833" },
  { label: "Jewelry classes", photo: "photo-1522065893269-6fd20f6d7438" },
  { label: "Weaving courses", photo: "photo-1618574760337-2750f6251d20" },
  { label: "Bookbinding workshops", photo: "photo-1757085242652-f8cd4d3de889" },
];

/*
 * The five store colours, muted to sit with the palette. A creator
 * choosing their own colour is a real feature of the product, so these
 * stay distinguishable; they no longer shout over the page they are on.
 */
const TINTS = ["#9a4a33", "#1f6b53", "#8a6a1f", "#4946a6", "#8d3352"];

export function SoldMarquee() {
  /*
   * Typographic, not photographic.
   *
   * This ran forty stock thumbnails — a loaf, a yoga mat, a sampler pad.
   * Stock photography is the ceiling on how considered a page can look,
   * because it is the one thing every templated site has; the best in
   * this category either commission portraits of named customers or draw
   * their own product, and neither is a thumbnail of somebody else's
   * bread.
   *
   * The names are the content. Set in one line, moving, they say what
   * forty pictures said and say it faster.
   */
  return (
    <div className="marquee" aria-hidden="true">
      <ul className="marquee-track items-center">
        {SOLD.map((item, i) => (
          <li key={item.label} className="flex shrink-0 items-center gap-[var(--gap-sm)]">
            <span className="whitespace-nowrap text-[1.0625rem] text-ink-soft">{item.label}</span>
            {i < SOLD.length - 1 ? (
              <span
                aria-hidden="true"
                className="h-1 w-1 shrink-0 rounded-full"
                style={{ background: TINTS[i % TINTS.length] }}
              />
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}
