import { readExtraOffers } from "@/lib/affiliate-extra-rules";
import { done, is } from "./check";

const offers = Array.from({ length: 51 }, (_, i) => ({
  aff: i.toString(36).padStart(12, "a"),
  items: ["guide1"],
}));
const kept = readExtraOffers(offers);

is("the existing maximum of 50 affiliate offers is enforced", kept.length, 50);
is("the final accepted offer remains in the kept list", kept.at(-1)?.aff, offers[49].aff);

done();
