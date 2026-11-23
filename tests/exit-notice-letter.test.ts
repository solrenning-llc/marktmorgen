/**
 * The closing notices tell the creator about the moved notice (97
 * [D2-OPEN-EXIT], unit 7: lib/plan-closing.ts, closingLetter): each of the
 * three letters, before the closing day, says the new address can be given
 * in the studio and what visitors see, for how long.
 */
import { done, is } from "./check";
import { closingLetter } from "@/lib/plan-closing";
import { EXIT_NOTICE_DAYS } from "@/lib/exit-redirect-rules";

const DAY = 86_400_000;
const endedAt = Date.UTC(2026, 10, 1);
const day = endedAt + 30 * DAY;
for (const [kind, now] of [["ended", endedAt + DAY], ["month", day - 14 * DAY], ["week", day - 7 * DAY]] as const) {
  const { text } = closingLetter(kind, "Kiln Goods", endedAt, day, now);
  is(`${kind}: says the new address can be given in the studio`, /give its new address in your studio/.test(text), true);
  is(`${kind}: says for how long and what visitors see`, text.includes(`for ${EXIT_NOTICE_DAYS} days`) && /old address here shows a link to it/.test(text), true);
  is(`${kind}: only until the closing day`, /before that day|until that day|Before then/.test(text), true);
}
done();
