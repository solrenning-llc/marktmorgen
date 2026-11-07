/**
 * The booking calendar's feed is asked once an hour by each of two apps (a
 * phone and a computer), and the pace allows exactly that (TODOS-11 proposal,
 * Claude 2, 7 November 2026). Its answers are the largest cost of the Store
 * plan's first month refunded (up to 2.3 MB each, sent and read): the file's
 * REFRESH-INTERVAL and X-PUBLISHED-TTL say how often an app asks, and
 * CALENDAR_POLLS_PER_HOUR is what the pace allows for two apps at that interval.
 * No page prints the interval; a new booking still reaches the creator by
 * email at once, and their calendar within the hour.
 */
import { readFileSync } from "node:fs";
import { CALENDAR_POLLS_PER_HOUR } from "@/lib/calendar-sync";
import { done, is, part } from "./check";

const APPS = 2;
const source = readFileSync("lib/calendar-sync.ts", "utf8");
const minutesOf = (name: string) => {
  const match = new RegExp(`${name}(?:;VALUE=DURATION)?:PT(\\d+)M`).exec(source);
  return match ? Number(match[1]) : null;
};

part("Each app asks once an hour, and the pace allows two apps");
const refresh = minutesOf("REFRESH-INTERVAL");
const ttl = minutesOf("X-PUBLISHED-TTL");
is("the file asks each app once an hour, in both of its headers", [refresh, ttl], [60, 60]);
is("the pace allows exactly two apps at that interval", CALENDAR_POLLS_PER_HOUR, refresh ? APPS * (60 / refresh) : -1);
done();
