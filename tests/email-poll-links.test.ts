/**
 * A recipient's poll link (125 [F2-EMAIL-POLLS], unit 2:
 * lib/email-poll-links.ts).
 *
 * What fails here:
 *   - a link that carries or needs the recipient's address;
 *   - a link accepted for another broadcast, another recipient, a changed
 *     signature, a position that is not one, or with no key set;
 *   - a link made when no key is set.
 */
import { checkPollLink, pollLinkPart } from "@/lib/email-poll-links";
import { done, is } from "./check";

const BC = "0123456789abcdef01234567";
const part = pollLinkPart(BC, 4);
is("made with the server's key", typeof part === "string" && /^4\.[0-9a-f]{32}$/.test(part!), true);
is("names no address", part!.includes("@"), false);
is("the same recipient and broadcast: the same link", pollLinkPart(BC, 4), part);
is("read back as that recipient", checkPollLink(BC, part), { ok: true, recipient: 4 });
is("another recipient's signature", checkPollLink(BC, `5.${part!.split(".")[1]}`), { ok: false });
is("another broadcast", checkPollLink("fedcba9876543210fedcba98", part), { ok: false });
is("a changed signature", checkPollLink(BC, `${part!.slice(0, -1)}${part!.endsWith("0") ? "1" : "0"}`), { ok: false });
for (const bad of ["", "4", "x.abc", "-1.00", "4.zz", "01.ab", `4.${"a".repeat(31)}`, null, 4, `100001.${"a".repeat(32)}`]) is(`not a link: ${JSON.stringify(bad)}`, checkPollLink(BC, bad), { ok: false });
is("a position that is not one is never made", [pollLinkPart(BC, -1), pollLinkPart(BC, 1.5), pollLinkPart(BC, Number.NaN)], [null, null, null]);

const saved = process.env.NIMBUS_DATA_KEY;
const savedStripe = process.env.STRIPE_SECRET_KEY;
delete process.env.NIMBUS_DATA_KEY;
delete process.env.STRIPE_SECRET_KEY;
is("no key: no link made", pollLinkPart(BC, 4), null);
is("no key: no link accepted, even one made before", checkPollLink(BC, part), { ok: false, unknown: true });
if (saved !== undefined) process.env.NIMBUS_DATA_KEY = saved;
if (savedStripe !== undefined) process.env.STRIPE_SECRET_KEY = savedStripe;

is("a broadcast id in another shape makes no link (Claude 3 on #3673, LEVE)", pollLinkPart("bc_0123456789abcdef", 4), null);
is("and checks none", checkPollLink("bc_0123456789abcdef", part), { ok: false });

done();
