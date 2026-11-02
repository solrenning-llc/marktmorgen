import type { IconName } from "@/components/icons";
import type { BlockKind } from "@/lib/sales-page";

/**
 * Each block kind's icon, as the sales page editor (components/page-editor.tsx)
 * and its block gallery draw it, and as the feature page's picture of the
 * editor draws it (components/feature-visuals.tsx). Kept here, outside the
 * editor's "use client" module, so a server component can read the same list.
 */
export const KIND_ICONS: Record<BlockKind, IconName> = {
  hero: "sparkle",
  text: "type",
  benefits: "check-circle",
  inside: "list",
  bio: "user",
  faq: "chat",
  guarantee: "shield",
  cta: "arrow-right",
  reviews: "star",
  video: "play",
  pictures: "camera",
  countdown: "clock",
  fit: "target",
  steps: "ladder",
  compare: "scale",
  bonuses: "gift",
  facts: "chart",
  feature: "layout",
  product: "basket",
  quotes: "quote",
  form: "list",
};
