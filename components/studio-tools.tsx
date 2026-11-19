import Link from "next/link";
import { Icon, type IconName } from "@/components/icons";

export type StudioTool = {
  href: string;
  title: string;
  /** One short line on what it is for. */
  text: string;
  icon: IconName;
  /** A word beside the title, such as the plan it belongs to. */
  tag?: string;
  /** Counted tools may opt out of automatic route prefetch. */
  prefetch?: false;
};

/**
 * The parts of the studio that have pages of their own.
 *
 * The bar at the top only jumps within this page, so a tap on it never
 * leaves it; what opens another page is gathered here instead, where each
 * one can say in a line what it is for. Two across on a phone, four on a
 * wide screen, and every tile is one big target.
 */
export function StudioTools({ tools }: { tools: StudioTool[] }) {
  if (tools.length === 0) return null;
  return (
    <section aria-labelledby="tools-title" className="mt-8">
      <h2 id="tools-title" className="text-sm font-semibold text-ink-soft">
        More in your studio
      </h2>
      <ul className={`mt-3 grid grid-cols-2 gap-3 ${tools.length >= 4 ? "lg:grid-cols-4" : "lg:grid-cols-3"}`}>
        {tools.map((tool) => (
          <li key={tool.href} className="min-w-0">
            <Link
              href={tool.href}
              prefetch={false}
              className="group flex h-full min-h-[44px] flex-col gap-2 rounded-2xl bg-white p-4 ring-1 ring-line transition-shadow hover:ring-violet-brand/40 hover:shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-brand motion-reduce:transition-none"
            >
              {/* Wraps: a tag such as "Studio plan" goes under the icon on a narrow tile, with text spacing (WCAG 1.4.12). */}
              <span className="flex flex-wrap items-center justify-between gap-2">
                <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-lilac text-violet-deep">
                  <Icon name={tool.icon} size={18} />
                </span>
                {tool.tag ? <span className="tag tag-brand">{tool.tag}</span> : null}
              </span>
              {/* The arrow follows the last word, so a title that wraps keeps it beside it. */}
              <span className="font-semibold text-ink">
                {tool.title.includes(" ") ? `${tool.title.slice(0, tool.title.lastIndexOf(" "))} ` : ""}
                <span className="whitespace-normal [overflow-wrap:anywhere]">
                  {tool.title.slice(tool.title.lastIndexOf(" ") + 1)}
                  <Icon
                    name="arrow-right"
                    size={15}
                    className="ml-1 inline-block align-[-2px] text-ink-mute transition-transform group-hover:translate-x-0.5 motion-reduce:transition-none"
                  />
                </span>
              </span>
              <span className="text-sm leading-snug text-ink-soft">{tool.text}</span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
