import { SiteNav as SiteNavMenus } from "@/components/site-nav";
import { PLANS_ON_SALE, PREVIEW_LINE, PREVIEW_LINK } from "@/lib/opening";

/*
 * The site's menu for server pages. The plans' state is read here, on the
 * server, and handed to the client menu (components/site-nav.tsx) as three
 * plain values, so the gates and margin reviews behind lib/opening.ts are
 * never shipped to a visitor's browser. Same markup, same behavior.
 */
export function SiteNav() {
  return <SiteNavMenus opening={{ onSale: PLANS_ON_SALE, line: PREVIEW_LINE, link: PREVIEW_LINK }} />;
}
