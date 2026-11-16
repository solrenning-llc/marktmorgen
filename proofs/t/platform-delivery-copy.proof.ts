import assert from "node:assert/strict";
import test from "node:test";
import { isValidElement, type ReactNode } from "react";
import PlatformIndex from "@/app/platform/page";
import { FeatureCatalogue, type CatalogueGroup } from "@/components/feature-catalogue";
import { CREATOR_JOURNEY } from "@/lib/creator-journey";
import { PLANS_ON_SALE } from "@/lib/opening";

function nodes(node: ReactNode): ReactNode[] {
  if (Array.isArray(node)) return node.flatMap(nodes);
  if (!isValidElement<{ children?: ReactNode }>(node)) return [node];
  return [node, ...nodes(node.props.children)];
}

function text(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(text).join("");
  return isValidElement<{ children?: ReactNode }>(node) ? text(node.props.children) : "";
}

const page = PlatformIndex();
const catalogues = nodes(page).filter(node => isValidElement(node) && node.type === FeatureCatalogue);
assert.equal(catalogues.length, 1, "inspect the actual page's existing catalogue, not a duplicate fixture");
const catalogue = catalogues[0];
assert.ok(isValidElement<{ groups: CatalogueGroup[] }>(catalogue));
const delivery = catalogue.props.groups.find(group => group.key === "deliver");
assert.ok(delivery, "the actual delivered catalogue must contain the delivery group");

test("the real public catalogue does not promise a fixed-second delivery time", () => {
  assert.doesNotMatch(delivery.line, /the second|the moment|immediate|instantly|within \d+ seconds?/i);
});

test("the real public delivery summary names the payment-dependent access condition", () => {
  assert.match(delivery.line, /recorded payment|confirmed payment|payment.*confirmed|payment.*checked/i);
  assert.match(delivery.line, /access|product.*terms|delivery/i);
});

test("the existing journey already explains the qualified access path", () => {
  const stage = CREATOR_JOURNEY.find(stage => stage.id === "deliver");
  assert.ok(stage);
  assert.match(stage.body, /confirmed payment/);
  assert.match(stage.body, /Access follows the recorded payment and the product's terms/);
  assert.ok(stage.features.some(feature => feature.slug === "instant-delivery"));
});

test("the real page preserves the current paid-selling availability notice", () => {
  const notices = nodes(page).filter(node => isValidElement<{ "data-journey-closed"?: boolean }>(node) && node.props["data-journey-closed"]);
  assert.equal(notices.length, PLANS_ON_SALE ? 0 : 1);
  if (!PLANS_ON_SALE) assert.match(text(notices), /Paid selling is not open yet/);
});
