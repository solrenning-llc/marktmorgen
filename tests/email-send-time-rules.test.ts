/**
 * STN11 unit 2a: a person's suggested send hour uses only link-use and
 * purchase moments that are already known. It never reads email opens.
 */
import {
  MAX_SEND_TIME_SIGNALS,
  SEND_TIME_LOOKBACK_DAYS,
  type SendTimeSignal,
  suggestedSendHour,
} from "@/lib/email-send-time-rules";
import { done, is, part } from "./check";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = Date.UTC(2026, 10, 10, 12);
const at = (hoursAgo: number, kind: SendTimeSignal["kind"] = "link"): SendTimeSignal => ({
  at: NOW - hoursAgo * HOUR,
  kind,
});

part("Unknown stays unknown");
is("no signals", suggestedSendHour([], "UTC", NOW), null);
is("fewer than three known signals", suggestedSendHour([at(1), at(25)], "UTC", NOW), null);
is("an unreadable collection", suggestedSendHour(null as never, "UTC", NOW), null);
is("an unknown time zone", suggestedSendHour([at(1), at(25), at(49)], "Unknown/Zone", NOW), null);
// C2 review 6759467753: missing zone evidence must never select the host zone.
is("a missing time zone stays unknown", suggestedSendHour([at(1), at(25), at(49)], undefined as never, NOW), null);
is("an empty time zone stays unknown", suggestedSendHour([at(1), at(25), at(49)], "", NOW), null);
is("a blank time zone stays unknown", suggestedSendHour([at(1), at(25), at(49)], "   ", NOW), null);
is("a null time zone stays unknown", suggestedSendHour([at(1), at(25), at(49)], null as never, NOW), null);
is("an unknown clock", suggestedSendHour([at(1), at(25), at(49)], "UTC", Number.NaN), null);

part("Only consented link use and purchases count");
const mixed = [
  at(3, "link"),
  at(27, "purchase"),
  at(51, "link"),
  { at: NOW - 75 * HOUR, kind: "open" },
] as unknown as SendTimeSignal[];
is("an email-open shaped value is ignored", suggestedSendHour(mixed, "UTC", NOW), { hour: 9, samples: 3 });
is(
  "invalid, future and expired moments are ignored",
  suggestedSendHour(
    [
      at(3),
      at(27),
      at(51),
      { at: Number.NaN, kind: "link" },
      { at: NOW + 1, kind: "purchase" },
      { at: NOW - SEND_TIME_LOOKBACK_DAYS * DAY - 1, kind: "link" },
    ],
    "UTC",
    NOW,
  ),
  { hour: 9, samples: 3 },
);
is(
  "the exact lookback boundary is known",
  suggestedSendHour([at(3), at(27), { at: NOW - SEND_TIME_LOOKBACK_DAYS * DAY, kind: "purchase" }], "UTC", NOW),
  { hour: 9, samples: 3 },
);

part("A local observed hour, never a promised outcome");
is("the person's time zone is used", suggestedSendHour([at(3), at(27), at(51)], "America/Fortaleza", NOW), { hour: 6, samples: 3 });
is(
  "the most frequent local hour wins",
  suggestedSendHour([at(3), at(27), at(51), at(4), at(28)], "UTC", NOW),
  { hour: 9, samples: 5 },
);
is(
  "a tie uses the most recent signal's hour",
  suggestedSendHour([at(3), at(27), at(4), at(28)], "UTC", NOW),
  { hour: 9, samples: 4 },
);
is(
  "daylight-saving rules come from the named time zone",
  suggestedSendHour(
    [
      { at: Date.UTC(2026, 6, 1, 13), kind: "link" },
      { at: Date.UTC(2026, 6, 2, 13), kind: "purchase" },
      { at: Date.UTC(2026, 6, 3, 13), kind: "link" },
    ],
    "America/New_York",
    Date.UTC(2026, 6, 4, 13),
  ),
  { hour: 9, samples: 3 },
);

part("Work is bounded before any future reader is added");
const many = Array.from({ length: MAX_SEND_TIME_SIGNALS + 20 }, (_, index) => ({
  at: NOW - index * 1_000,
  kind: "link" as const,
}));
is("only the newest bounded sample is considered", suggestedSendHour(many, "UTC", NOW), { hour: 11, samples: MAX_SEND_TIME_SIGNALS });
is("the bound is finite and deliberately small", MAX_SEND_TIME_SIGNALS, 100);

done();
