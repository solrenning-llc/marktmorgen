/**
 * What the time picker says (components/slot-picker.tsx), in the store's
 * language: on the booking page, the page that moves a booking, and the
 * calendar embedded in the creator's own site (app/embed).
 */
import { type BookingWords } from "@/lib/buyer-words/booking";
import { speech } from "@/lib/buyer-words";
import type { SlotWords } from "@/components/slot-picker";
import type { Store } from "@/lib/store";

export function slotWords(store: Store, b: BookingWords, minutes: number, price: string, move: boolean, fromPackage: boolean): SlotWords {
  const { w, lang } = speech(store);
  return {
    locale: lang.locale,
    pickDay: b.pickDay,
    pickTime: w.pickTime,
    noneTitle: move ? b.noOtherTimes : b.noTimes,
    noneBody: move ? b.noOtherTimesBody : b.noTimesBody,
    yours: b.timesInYours("{zone}"),
    creators: b.timesInCreators("{zone}"),
    chosen: b.chosenLength(minutes),
    submit: move ? b.moveToTime : fromPackage ? b.bookFromPackage : b.continueToPay(price),
    note: move ? b.moveNoCharge : fromPackage ? b.packageNoCharge : b.timeKept,
  };
}
