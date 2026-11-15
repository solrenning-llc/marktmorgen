// Key families of the topic "nl:mail..." (lib/data-families.ts says what each part means).
// Add a family of this topic here, in alphabetical order (entries under one comment stay together under it);
// a new topic is a new file, then run node scripts/data-families-index.mjs.
import { C, Cr, E, I, T, type TopicFamilies } from "@/lib/data-family-kinds";

export const families: TopicFamilies = {
  counted: [
    "nl:mail:bc:",
    "nl:mail:bcs:",
    "nl:mail:enr:",
    "nl:mail:flowq",
    "nl:mail:flows:",
    "nl:mail:mk:",
    "nl:mail:unsub:",
  ],
  elsewhere: [
    "nl:mail:clk:",
    "nl:mail:day:",
    "nl:mail:drafts:",
    "nl:mail:flowq:lease",
    "nl:mail:flowstats:",
    "nl:mail:health:",
    "nl:mail:lock",
    "nl:mail:paused:",
    "nl:mail:pin:",
    "nl:mail:queue",
    "nl:mail:ramp:",
    "nl:mail:segs:",
    "nl:mail:used:",
  ],
  closing: {
    "nl:mail:bc:": T("nl:mail:bcs:"),
    "nl:mail:bcs:": E,
    "nl:mail:clk:": E,
    "nl:mail:day:": C,
    "nl:mail:drafts:": E,
    "nl:mail:enr:": E,
    "nl:mail:flowq": I,
    "nl:mail:flowq:lease": I,
    "nl:mail:flows:": E,
    "nl:mail:flowstats:": E,
    "nl:mail:health:": E,
    "nl:mail:lock": C,
    "nl:mail:mk:": T("nl:store:leads:", 400),
    "nl:mail:paused:": E,
    // A PayPal receipt tried again (lib/paypal-delivery.ts, lib/email.ts sendEmailPinned): the time of its first try,
    // named by the order and holding only that time, gone within RECEIPT_MARK_SECONDS; the sender kept for its key, the company's, a day.
    "nl:mail:pin:": Cr(1),
    "nl:mail:queue": I,
    "nl:mail:ramp:": E,
    "nl:mail:segs:": E,
    "nl:mail:unsub:": T("nl:store:leads:"),
    "nl:mail:used:": E,
  },
  followed: [
    "nl:mail:bcs:",
  ],
};
