/**
 * The name a calendar address is shown under (providerOf in
 * lib/calendar-sync.ts). It only labels the feed for the creator; what is
 * fetched is decided by lib/safe-fetch.ts. What is checked: a service's name
 * is given to its own domain and the names under it, never to another domain
 * that merely ends in the same letters ("evilicloud.com" is not iCloud).
 */
import { providerOf } from "@/lib/calendar-sync";
import { done, is, part } from "./check";

part("The services' own addresses");
is("iCloud", providerOf("webcal://p01-caldav.icloud.com/published/2/abc"), "iCloud");
is("Google Calendar", providerOf("https://calendar.google.com/calendar/ical/x/basic.ics"), "Google Calendar");
is("Outlook", [providerOf("https://outlook.office365.com/owa/calendar/x/calendar.ics"), providerOf("https://outlook.live.com/owa/x.ics"), providerOf("https://outlook.office.com/x.ics")], ["Outlook", "Outlook", "Outlook"]);
is("Fastmail and Calendly, bare and under a name", [providerOf("https://fastmail.com/x.ics"), providerOf("https://user.fastmail.com/x.ics"), providerOf("https://calendly.com/x.ics")], ["Fastmail", "Fastmail", "Calendly"]);

part("A domain that only ends in the same letters");
is("not iCloud", providerOf("https://evilicloud.com/x.ics"), "evilicloud.com");
is("not Fastmail, Calendly or Outlook", [providerOf("https://notfastmail.com/x.ics"), providerOf("https://mycalendly.com/x.ics"), providerOf("https://fakeoutlook.live.com/x.ics")], ["notfastmail.com", "mycalendly.com", "fakeoutlook.live.com"]);
is("any other address is shown by its own name", [providerOf("https://www.example.org/cal.ics"), providerOf("not an address")], ["example.org", "Calendar"]);

done();
