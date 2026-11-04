/**
 * A passkey made in a test: a P-256 key pair, its public half kept as the
 * account's in COSE form (lib/passkeys.ts), and answers to a sign-in's
 * challenge signed with the private half, as a browser would send them.
 * Synthetic only: bound to the test's own RP_ID and SITE_URL.
 */
import { createHash, createSign, generateKeyPairSync } from "node:crypto";
import { RP_ID } from "@/lib/passkeys";
import { SITE_URL } from "@/lib/site-url";
import { store as redis } from "./redis-stub";

const sha = (value: string | Buffer) => createHash("sha256").update(value).digest();
const hex = (value: string) => createHash("sha256").update(value).digest("hex");

/** A passkey made here: a P-256 key pair, its public half kept as the account's, in COSE form. */
export function makePasskey(email: string, id: string) {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = publicKey.export({ format: "jwk" }) as { x: string; y: string };
  const x = Buffer.from(jwk.x, "base64url");
  const y = Buffer.from(jwk.y, "base64url");
  // {1: 2 (EC2), 3: -7 (ES256), -1: 1 (P-256), -2: x, -3: y}
  const cose = Buffer.concat([Buffer.from([0xa5, 0x01, 0x02, 0x03, 0x26, 0x20, 0x01, 0x21, 0x58, 0x20]), x, Buffer.from([0x22, 0x58, 0x20]), y]);
  const record = { id, publicKey: cose.toString("base64url"), counter: 0, transports: ["internal"], name: "Phone", createdAt: "", lastUsedAt: "", synced: true };
  let counter = 0;
  return {
    /** Kept beside the account's other passkeys, as adding one in the studio keeps it. */
    async keep() {
      const list = `nl:pk:${hex(`nimbus-passkeys:${email}`).slice(0, 40)}`;
      const [raw] = await redis.pipeline([["GET", list]]);
      const before = typeof raw === "string" ? (JSON.parse(raw) as unknown[]) : [];
      await redis.pipeline([
        ["SET", list, JSON.stringify([...before, record])],
        ["SET", `nl:pk:cred:${hex(`nimbus-passkey-id:${id}`).slice(0, 40)}`, email],
      ]);
    },
    /** What a browser answers to the sign-in options, signed by this key. */
    answer(challenge: string) {
      counter += 1;
      const count = Buffer.alloc(4);
      count.writeUInt32BE(counter);
      const authData = Buffer.concat([sha(RP_ID), Buffer.from([0x05]), count]);
      const clientData = Buffer.from(JSON.stringify({ type: "webauthn.get", challenge, origin: SITE_URL, crossOrigin: false }));
      const signer = createSign("SHA256");
      signer.update(Buffer.concat([authData, sha(clientData)]));
      const signature = signer.sign(privateKey);
      return {
        id,
        rawId: id,
        type: "public-key",
        clientExtensionResults: {},
        response: { authenticatorData: authData.toString("base64url"), clientDataJSON: clientData.toString("base64url"), signature: signature.toString("base64url") },
      };
    },
  };
}

