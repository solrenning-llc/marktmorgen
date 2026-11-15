import { createHmac } from "node:crypto";
import { CREATOR } from "@/lib/community";
import { deriveKey } from "@/lib/secret-box";

/**
 * Who said a message in a community's room, as other members are told it (#4589).
 *
 * The room keeps each member's key (lib/community.ts memberKey, an unsalted hash of the address) as the author, inside
 * the server. Handing that out would let anyone who guesses an address check it offline against a member who chose a
 * display name, and follow the same person from one community to another. So what leaves the server is an HMAC of
 * that key under a deployment secret (lib/secret-box.ts deriveKey), scoped to the community: stable inside one room,
 * so the page can still tell which messages are its own, and unrelated between rooms. The creator stays CREATOR.
 *
 * With no secret to derive from there is nothing safe to hand out, so it throws, and the route answers that the room
 * is unavailable rather than send the keys as they are.
 */
export function chatAuthor(room: string, author: string): string {
  if (author === CREATOR) return CREATOR;
  const key = deriveKey("community-chat-author");
  if (!key) throw new Error("no secret to name a room's authors with");
  return createHmac("sha256", key).update(`${room}|${author}`).digest("hex").slice(0, 32);
}
