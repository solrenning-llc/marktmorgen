/**
 * How many devices one license key may run on (610 [WP9], unit 1,
 * lib/licence-activation-rules.ts). Pure rules only; nothing reads or writes
 * the store yet. Checked: the creator's limit (off, 1 to 10, anything else
 * refused); the device identifier the creator's software sends; activation
 * up to the limit and refused past it; the same device twice takes one place;
 * a revoked or refunded key never activates; a record that cannot be read is
 * never taken as empty (rule 24); releasing a device frees a place, at most
 * RELEASES_PER_WINDOW times in RELEASE_WINDOW_SECONDS; the public reply never
 * names who bought.
 */
import {
  MAX_ACTIVATIONS,
  MAX_DEVICE_ID_LENGTH,
  MIN_DEVICE_ID_LENGTH,
  RELEASES_PER_WINDOW,
  RELEASE_WINDOW_SECONDS,
  type KeyActivations,
  activationReply,
  cleanDeviceId,
  decideActivation,
  decideRelease,
  parseActivationLimit,
  parseKeyActivations,
  releasesLeft,
} from "@/lib/licence-activation-rules";
import { done, is, part } from "./check";

const NOW = 1_800_000_000;
const DAY = 86_400;
const A = "device-aaaa-0001";
const B = "device-bbbb-0002";
const C = "device-cccc-0003";
const empty: KeyActivations = { devices: [], releases: [] };

part("The creator's limit");
is("not set means off, as every key works today", parseActivationLimit(undefined), 0);
is("0 is off", parseActivationLimit(0), 0);
is("1 device", parseActivationLimit(1), 1);
is("10 devices, the most", parseActivationLimit(MAX_ACTIVATIONS), 10);
is("typed as text in the editor", parseActivationLimit(" 3 "), 3);
is("11 is refused, never cut to 10", parseActivationLimit(11), null);
is("a negative number is refused", parseActivationLimit(-1), null);
is("a fraction is refused", parseActivationLimit(2.5), null);
is("words are refused", parseActivationLimit("two"), null);
is("null is refused, never read as off", parseActivationLimit(null), null);
is("an empty text is refused", parseActivationLimit(""), null);

part("The device identifier the creator's software sends");
is("kept as sent, spaces around it trimmed", cleanDeviceId(`  ${A}  `), A);
is("too short", cleanDeviceId("x".repeat(MIN_DEVICE_ID_LENGTH - 1)), null);
is("the shortest", cleanDeviceId("x".repeat(MIN_DEVICE_ID_LENGTH)), "x".repeat(MIN_DEVICE_ID_LENGTH));
is("the longest", cleanDeviceId("x".repeat(MAX_DEVICE_ID_LENGTH)), "x".repeat(MAX_DEVICE_ID_LENGTH));
is("too long", cleanDeviceId("x".repeat(MAX_DEVICE_ID_LENGTH + 1)), null);
is("a space inside", cleanDeviceId("device one two"), null);
is("markup", cleanDeviceId("<script>alert(1)</script>"), null);
is("a GUID with braces", cleanDeviceId("{3F2504E0-4F89-11D3-9A0C-0305E82C3301}"), "{3F2504E0-4F89-11D3-9A0C-0305E82C3301}");
is("not text", cleanDeviceId(12345678), null);

part("The kept record: read whole or not at all");
is("an empty record", parseKeyActivations({ devices: [], releases: [] }), empty);
is("a record with a device and a release", parseKeyActivations({ devices: [{ device: A, at: NOW }], releases: [NOW - DAY] }), { devices: [{ device: A, at: NOW }], releases: [NOW - DAY] });
is("missing (never written) is not the same as empty: null", parseKeyActivations(null), null);
is("a device twice", parseKeyActivations({ devices: [{ device: A, at: NOW }, { device: A, at: NOW }], releases: [] }), null);
is("a device with no time", parseKeyActivations({ devices: [{ device: A }], releases: [] }), null);
is("a bad identifier", parseKeyActivations({ devices: [{ device: "bad id", at: NOW }], releases: [] }), null);
is("more devices than any limit allows", parseKeyActivations({ devices: Array.from({ length: MAX_ACTIVATIONS + 1 }, (_, i) => ({ device: `device-${String(i).padStart(4, "0")}`, at: NOW })), releases: [] }), null);
is("a release that is not a time", parseKeyActivations({ devices: [], releases: ["yesterday"] }), null);
is("no releases list", parseKeyActivations({ devices: [] }), null);
// Codex C2 on #3622: the writer never keeps more than RELEASES_PER_WINDOW releases, so a longer list is not a record it wrote.
const releasesOf = (n: number, at: (i: number) => number) => Array.from({ length: n }, (_, i) => at(i));
is("more releases than a window allows, all recent: null", parseKeyActivations({ devices: [], releases: releasesOf(RELEASES_PER_WINDOW + 1, (i) => NOW - i * 60) }), null);
is("more releases than a window allows, all long past: null", parseKeyActivations({ devices: [], releases: releasesOf(RELEASES_PER_WINDOW + 1, (i) => NOW - 400 * DAY - i * 60) }), null);
is("control: exactly as many as a window allows is read whole", parseKeyActivations({ devices: [], releases: releasesOf(RELEASES_PER_WINDOW, (i) => NOW - i * 60) })?.releases.length, RELEASES_PER_WINDOW);

part("Activating a device");
const first = decideActivation({ key: "valid", limit: 2, record: empty, device: A, now: NOW });
is("the first device takes a place", first, { outcome: "activated", used: 1, limit: 2, record: { devices: [{ device: A, at: NOW }], releases: [] } });
const second = first.outcome === "activated" ? decideActivation({ key: "valid", limit: 2, record: first.record, device: B, now: NOW + 1 }) : null;
is("the second device takes the second place", second?.outcome === "activated" ? second.record.devices.map((d) => d.device) : null, [A, B]);
const full = second?.outcome === "activated" ? second.record : empty;
is("a third device is refused past the limit", decideActivation({ key: "valid", limit: 2, record: full, device: C, now: NOW + 2 }), { outcome: "full", used: 2, limit: 2 });
is("a device already on the key takes no new place", decideActivation({ key: "valid", limit: 2, record: full, device: A, now: NOW + 3 }), { outcome: "already", used: 2, limit: 2 });
is("lowered limit: a device already on it still runs", decideActivation({ key: "valid", limit: 1, record: full, device: B, now: NOW + 3 }), { outcome: "already", used: 2, limit: 1 });
is("lowered limit: a new device is refused", decideActivation({ key: "valid", limit: 1, record: full, device: C, now: NOW + 3 }), { outcome: "full", used: 2, limit: 1 });
is("a revoked or refunded key never activates", decideActivation({ key: "revoked", limit: 2, record: empty, device: A, now: NOW }), { outcome: "revoked" });
is("a key never given never activates", decideActivation({ key: "unknown", limit: 2, record: empty, device: A, now: NOW }), { outcome: "unknown_key" });
is("a revoked key with devices on it still does not activate them", decideActivation({ key: "revoked", limit: 2, record: full, device: A, now: NOW }), { outcome: "revoked" });
is("limit off: the key is checked as today, nothing kept", decideActivation({ key: "valid", limit: 0, record: null, device: null, now: NOW }), { outcome: "off" });
is("limit on, no device sent", decideActivation({ key: "valid", limit: 2, record: empty, device: null, now: NOW }), { outcome: "bad_device" });
is("limit on, the record could not be read: refused, never taken as empty", decideActivation({ key: "valid", limit: 2, record: null, device: A, now: NOW }), { outcome: "unavailable" });
is("a limit that could not be read is refused too", decideActivation({ key: "valid", limit: null, record: empty, device: A, now: NOW }), { outcome: "unavailable" });

part("Releasing a device from the buyer's purchases");
const released = decideRelease({ record: full, device: A, now: NOW + DAY });
is("releasing frees its place", released.outcome === "released" ? released.record.devices.map((d) => d.device) : null, [B]);
is("and the release is counted", released.outcome === "released" ? released.record.releases : null, [NOW + DAY]);
const again = released.outcome === "released" ? decideActivation({ key: "valid", limit: 2, record: released.record, device: C, now: NOW + DAY + 1 }) : null;
is("the freed place takes a new device", again?.outcome === "activated" ? again.record.devices.map((d) => d.device) : null, [B, C]);
is("a device not on the key", decideRelease({ record: full, device: C, now: NOW }), { outcome: "not_found" });
is("a record that could not be read", decideRelease({ record: null, device: A, now: NOW }), { outcome: "unavailable" });
const used: KeyActivations = { devices: [{ device: A, at: NOW }], releases: Array.from({ length: RELEASES_PER_WINDOW }, (_, i) => NOW - 10 * DAY + i) };
is("no release left in the window: refused, with when the next one opens", decideRelease({ record: used, device: A, now: NOW }), { outcome: "limit", nextAt: NOW - 10 * DAY + RELEASE_WINDOW_SECONDS });
is("releases left now", releasesLeft(used, NOW), 0);
is("a release older than the window no longer counts", releasesLeft(used, NOW - 10 * DAY + RELEASE_WINDOW_SECONDS), 1);
const later = decideRelease({ record: used, device: A, now: NOW + RELEASE_WINDOW_SECONDS });
is("after the window it is allowed, and old releases are dropped from the record", later.outcome === "released" ? later.record.releases : null, [NOW + RELEASE_WINDOW_SECONDS]);
is("releases left on a fresh key", releasesLeft(empty, NOW), RELEASES_PER_WINDOW);

part("The public reply says nothing about who bought");
const replies = [
  activationReply(first),
  activationReply({ outcome: "already", used: 2, limit: 2 }),
  activationReply({ outcome: "full", used: 2, limit: 2 }),
  activationReply({ outcome: "revoked" }),
  activationReply({ outcome: "unknown_key" }),
  activationReply({ outcome: "off" }),
  activationReply({ outcome: "bad_device" }),
  activationReply({ outcome: "unavailable" }),
];
is("activated", replies[0], { valid: true, activated: true, reason: "activated", used: 1, limit: 2 });
is("already on it", replies[1], { valid: true, activated: true, reason: "already_active", used: 2, limit: 2 });
is("full", replies[2], { valid: true, activated: false, reason: "device_limit", used: 2, limit: 2 });
is("revoked", replies[3], { valid: false, activated: false, reason: "revoked" });
is("never given", replies[4], { valid: false, activated: false, reason: "unknown_key" });
is("limit off", replies[5], { valid: true, activated: false, reason: "no_limit" });
is("bad device", replies[6], { valid: false, activated: false, reason: "bad_device" });
is("could not be read: never a yes", replies[7], { valid: false, activated: false, reason: "unavailable" });
is("no reply carries an email, an order or a record", replies.every((r) => !/@|cs_|pi_|devices|record|email/.test(JSON.stringify(r))), true);

done();
