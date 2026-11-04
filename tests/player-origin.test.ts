/**
 * Which postMessage a sales page takes as a video player's (lib/player-origin.ts,
 * components/page-depth.tsx; security audit 506 [SG1], MM-SA-27, 4 November
 * 2026). Only the exact origins of the frames the page draws count, and only
 * from the window of one of those frames.
 */
import { readFileSync } from "node:fs";
import { PLAYER_ORIGINS, framePlayer, frameTarget, isPlayerOrigin, messagePlayer, playerOf } from "@/lib/player-origin";
import { embedUrl } from "@/lib/sales-page";
import { done, is, part } from "./check";

part("The origins are the ones the page embeds");
const youtubeFrame = embedUrl({ provider: "youtube", id: "dQw4w9WgXcQ", hash: "" });
const vimeoFrame = embedUrl({ provider: "vimeo", id: "123456789", hash: "" });
is("YouTube's frame origin is a YouTube player", playerOf(new URL(youtubeFrame).origin), "youtube");
is("Vimeo's frame origin is a Vimeo player", playerOf(new URL(vimeoFrame).origin), "vimeo");
is("exactly those two origins, nothing more", Object.keys(PLAYER_ORIGINS).sort(), [new URL(youtubeFrame).origin, new URL(vimeoFrame).origin].sort());
is("framePlayer reads the frames the page draws", [framePlayer(youtubeFrame), framePlayer(vimeoFrame)], ["youtube", "vimeo"]);

part("Look-alike origins are not players");
for (const origin of [
  "https://evilvimeo.com",
  "https://notvimeo.com",
  "https://vimeo.com.evil.example",
  "https://player.vimeo.com.evil.example",
  "http://player.vimeo.com",
  "https://player.vimeo.com:8443",
  "https://youtube.evil.com",
  "https://notyoutube.example",
  "https://www.youtube-nocookie.com.evil.example",
  "http://www.youtube.com",
  "http://www.youtube-nocookie.com",
  "https://WWW.YOUTUBE-NOCOOKIE.COM.evil.example",
  "https://www.youtube-nocookie.com/",
  "null",
  "",
  "__proto__",
  "constructor",
]) {
  is(`not a player: ${JSON.stringify(origin)}`, [isPlayerOrigin(origin), playerOf(origin)], [false, null]);
}
is("not a string is not a player", [isPlayerOrigin(undefined), isPlayerOrigin(null), isPlayerOrigin(42)], [false, false, false]);
is("a frame from elsewhere is not a player", [framePlayer("https://evilvimeo.com/video/1"), framePlayer("not a url"), framePlayer("")], [null, null, null]);

part("The real ones");
is("https://www.youtube-nocookie.com", playerOf("https://www.youtube-nocookie.com"), "youtube");
is("https://player.vimeo.com", playerOf("https://player.vimeo.com"), "vimeo");

part("The sender must be one of the page's player frames");
const ytWindow = { name: "youtube frame" };
const vmWindow = { name: "vimeo frame" };
const otherWindow = { name: "some other window" };
const frames = [
  { src: youtubeFrame, contentWindow: ytWindow },
  { src: vimeoFrame, contentWindow: vmWindow },
];
is("from the YouTube frame, at its origin", messagePlayer(frames, ytWindow, "https://www.youtube-nocookie.com"), "youtube");
is("from the Vimeo frame, at its origin", messagePlayer(frames, vmWindow, "https://player.vimeo.com"), "vimeo");
is("a player origin from a window that is not one of the frames", messagePlayer(frames, otherWindow, "https://player.vimeo.com"), null);
is("the YouTube frame's window claiming Vimeo's origin", messagePlayer(frames, ytWindow, "https://player.vimeo.com"), null);
is("no sender", [messagePlayer(frames, null, "https://player.vimeo.com"), messagePlayer(frames, undefined, "https://player.vimeo.com")], [null, null]);
is("a frame whose window is gone does not match a missing sender", messagePlayer([{ src: vimeoFrame, contentWindow: null }], null, "https://player.vimeo.com"), null);
is("a look-alike origin from a real frame", messagePlayer(frames, vmWindow, "https://evilvimeo.com"), null);
is("no frames on the page", messagePlayer([], ytWindow, "https://www.youtube-nocookie.com"), null);

part("The page uses it");
const page = readFileSync("components/page-depth.tsx", "utf8");
is("no loose origin pattern is left in the page", /\/youtube\/\.test|vimeo\\\.com\$/.test(page), false);
is("the page checks each message's sender and origin with messagePlayer", /messagePlayer\([^;]*,\s*event\.source\s*,\s*event\.origin\s*\)/.test(page), true);

part("Messages to a player go to its own origin, never to any");
is("a player frame's target is its exact origin", [frameTarget(youtubeFrame), frameTarget(vimeoFrame)], [new URL(youtubeFrame).origin, new URL(vimeoFrame).origin]);
is("anything else has no target", ["https://evilvimeo.com/video/1", "http://player.vimeo.com/video/1", "not a url", ""].map(frameTarget), [null, null, null, null]);
const depthSource = readFileSync("components/page-depth.tsx", "utf8");
is("the sales page never posts to \"*\"", /postMessage\([^;]*,\s*"\*"\s*\)/.test(depthSource), false);
is("and posts only to frameTarget's answer", (depthSource.match(/postMessage\(/g) ?? []).length === (depthSource.match(/postMessage\([^;]*, target\)/g) ?? []).length, true);

done();
