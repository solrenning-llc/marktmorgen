/**
 * 241 [CF4], unit 1: what short product videos on the feature pages would
 * cost Marktmorgen a month, and the ceiling that keeps it bounded. A PROPOSAL:
 * nothing is filmed, uploaded or shown by this unit.
 *
 * Checked against the code, with no figure typed in the record:
 *   - one video per feature page (lib/site-pages.ts slugsFor("platform")), the
 *     most there could be;
 *   - each at most FEATURE_VIDEO_SECONDS, weighed by lib/stream-rules.ts
 *     viewingBytes at its top height, fetched ahead as tests/plan-cost-registry.ts
 *     counts a lesson hour (FETCHED_AHEAD);
 *   - delivered at the dearest Standard-network region read on 11 November
 *     2026, never the "from" price, since a "from" price is not a ceiling;
 *   - kept at every height of the ladder, in the most replication regions the
 *     service offers;
 *   - a monthly play ceiling, past which the page shows the transcript and the
 *     still picture, never the video, so the cost can never pass the ceiling;
 *   - docs/feature-videos-cost.md is exactly what the renderer writes
 *     (node scripts/feature-videos-cost.mjs).
 */
import { readFileSync, existsSync } from "node:fs";
import { slugsFor } from "@/lib/site-pages";
import { viewingBytes, TOP_HEIGHT } from "@/lib/stream-rules";
import { FETCHED_AHEAD, GB } from "./plan-cost-registry";
import {
  DEAREST_DELIVERY_PER_GB,
  FEATURE_VIDEO_SECONDS,
  MAX_REPLICATION_REGIONS,
  MONTHLY_PLAY_CEILING,
  featureVideoCost,
  renderFeatureVideosCost,
} from "./feature-videos-cost-table";
import { done, is, part } from "./check";

const cost = featureVideoCost();

part("The most videos there could be, at their most weight");
is("one per feature page", cost.videos, slugsFor("platform").length);
is("a play weighs the top height, fetched ahead", cost.bytesPerPlay, Math.round(viewingBytes(FEATURE_VIDEO_SECONDS, TOP_HEIGHT, Number.POSITIVE_INFINITY) * FETCHED_AHEAD));
is("short: a minute at most", FEATURE_VIDEO_SECONDS <= 60, true);

part("Delivery at the dearest region, never the starting price");
is("the dearest Standard-network region read on 11 November 2026: $0.06 a GB", DEAREST_DELIVERY_PER_GB, 0.06);
is("a month at the play ceiling", cost.deliveryMonthUsd, (MONTHLY_PLAY_CEILING * cost.bytesPerPlay / GB) * DEAREST_DELIVERY_PER_GB);
is("kept in the most regions the service offers", MAX_REPLICATION_REGIONS, 8);

part("The ceiling bounds the month");
is("the month never passes storage plus delivery at the ceiling", cost.monthCeilingUsd, cost.storageMonthUsd + cost.deliveryMonthUsd);
is("one more play than the ceiling is not delivered", cost.playsDeliveredAt(MONTHLY_PLAY_CEILING + 1), MONTHLY_PLAY_CEILING);

part("The record");
const doc = renderFeatureVideosCost();
is("a PROPOSAL, said first", doc.split("\n").slice(0, 4).join("\n").includes("PROPOSAL"), true);
is("unknowns are named, never zero", [/never zero/i.test(doc), /unknown/i.test(doc)], [true, true]);
is("it has an Acessibilidade section", doc.includes("## Acessibilidade"), true);
is("docs/feature-videos-cost.md is current (node scripts/feature-videos-cost.mjs)", existsSync("docs/feature-videos-cost.md") ? readFileSync("docs/feature-videos-cost.md", "utf8") : "", doc);

done();
