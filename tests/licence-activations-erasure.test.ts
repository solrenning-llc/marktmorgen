/**
 * 610 [WP9] unit 2: what deleting a person does to the devices of their
 * license keys (coordinator's check, 11 November 2026).
 *
 * Today the erasure keeps a person's license keys on purpose, with the sale
 * and the buyer's address (lib/person-data.ts, "kept"; no eraser in
 * lib/person-erasure.ts touches lib/licence-keys.ts). The devices are kept
 * with their key, so they go the same way as the key: if the key is ever
 * erased or detached from the person, this file fails until the device
 * record is erased in the same path.
 *
 * Kept, so the registry line and the privacy policy say exactly what is kept
 * and why it is not the device: a one-way code made with a key only the
 * server holds, different for every license key, never the identifier the
 * creator's software sent, gone by itself 400 days after its last change.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PERSON_DATA } from "@/lib/person-data";
import { ERASERS } from "@/lib/person-erasure";
import { ACTIVATION_KEEP_SECONDS } from "@/lib/licence-activations";
import { done, is, part } from "./check";

const keys = PERSON_DATA.find((d) => d.file === "lib/licence-keys.ts");
const devices = PERSON_DATA.find((d) => d.file === "lib/licence-activations.ts");
const words = (d: typeof devices) => (d ? `${d.what} ${"why" in d ? d.why : ""}` : "");
const days = ACTIVATION_KEEP_SECONDS / 86_400;

part("The devices go the same way as their key");
is("the key is kept by the erasure today", keys?.how, "kept");
is("so its devices are kept with it, never more or less than the key", devices?.how, keys?.how);
is("no eraser touches either of them", ERASERS.filter((e) => e.module === "lib/licence-keys.ts" || e.module === "lib/licence-activations.ts").map((e) => e.module), []);

part("The registry says what is kept and why it is not the device");
const line = words(devices);
is("a one-way code", /one-way code/i.test(line), true);
is("made with a key only the server holds", /key only (our|the) server holds/i.test(line), true);
is("different for every license key", /different for every license key/i.test(line), true);
is("never the identifier the software sent", /never the identifier/i.test(line), true);
is("kept with the key, and gone by itself after its term", line.includes("kept with the key") && line.includes(`${days} days`), true);

part("The privacy policy says the same");
const privacy = readFileSync(join(process.cwd(), "app/privacy/page.tsx"), "utf8").replace(/\s+/g, " ");
const section = privacy.slice(privacy.indexOf('id="license-keys"'), privacy.indexOf("</p>", privacy.indexOf('id="license-keys"')));
is("the license keys section names the devices", /devices/.test(section), true);
is("as a one-way code from a key only our server holds", /one-way code/.test(section) && /key only our server holds/.test(section), true);
is("different for every license key, never the identifier", /different for every license key/.test(section) && /never the identifier/.test(section), true);
is("gone by itself after its term", section.includes(`${days} days`), true);
is("and what a deletion keeps lists them with the keys", /license keys you bought and the codes of the devices they run on/.test(privacy), true);

done();
