/**
 * A whole switch that is on, for tests only: the reviewed constant, the seller, the registration in effect and the
 * owner's review of that very registration (lib/vat-registrations.ts). Synthetic values; a checkout is given these
 * inputs (`vatSwitch`) and still decides through euVatCollectOn / ukVatCollectOn, never through a bare yes.
 */
import type { SwitchInput } from "@/lib/vat-registrations";

const seller = { legalName: "Example Platform LLC", address: "1 Example Street, Dover, DE 19901, United States" };

/** The EU switch on: Ireland's non-Union OSS number (EU372…), in effect from 1 November 2026, reviewed by the owner. */
export const EU_SWITCH_ON: Omit<SwitchInput, "now"> = {
  reviewed: true,
  seller,
  eu: { memberState: "IE", vatNumber: "EU372000001", effectiveFrom: "2026-11-01" },
  reviews: [{ jurisdiction: "EU", registration: "EU372000001", reviewedOn: "2026-11-01", reviewer: "owner" }],
};

/** The UK switch on: a 9-digit UK VAT number in effect from 1 November 2026, reviewed by the owner. */
export const UK_SWITCH_ON: Omit<SwitchInput, "now"> = {
  reviewed: true,
  seller,
  uk: { vatNumber: "123456789", effectiveFrom: "2026-11-01" },
  reviews: [{ jurisdiction: "UK", registration: "123456789", reviewedOn: "2026-11-01", reviewer: "owner" }],
};
