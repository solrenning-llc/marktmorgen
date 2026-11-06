import type { MetadataRoute } from "next";
import { SITE_URL } from "@/lib/site-url";

/**
 * What a crawler may read, and where the map is.
 *
 * Everything public is open on purpose: the comparison pages and the journal
 * exist to be found, and a creator's store page is something they want indexed
 * too — that is the whole point of having an address.
 *
 * What is closed is the machinery. /api/ is not a page. /studio and /signin
 * belong to one creator and already carry noindex, but a crawler should not
 * spend requests discovering that.
 *
 * Except two doors under /api/ that are pictures every visitor already sees
 * (248 [ST1], 271 [SEO1]): a product's picture (/api/image/, which a
 * product's structured data names as its image) and a store's photo
 * (/api/photo/). Closed, search engines could not read the image the page
 * itself points them to. Each is paced and cached for a year
 * (lib/picture-pace.ts), so a crawler reads within the same ceilings as
 * anyone. The longer rule wins for a crawler, so the rest of /api/ stays shut.
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: "*",
      allow: ["/", "/api/image/", "/api/photo/"],
      disallow: ["/api/", "/studio", "/signin"],
    },
    sitemap: `${SITE_URL}/sitemap.xml`,
    host: SITE_URL,
  };
}
