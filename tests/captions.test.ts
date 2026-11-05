/**
 * A captions file a creator uploads is kept as WebVTT, whichever of the two
 * usual kinds it arrived as, and a file that is not captions is refused
 * (lib/captions.ts).
 *
 * What matters is what a student's player is handed: times it can read, the
 * words, and nothing else.
 */
import { CAPTION_LANGUAGES, MAX_CAPTION_BYTES, captionLabel, toVtt } from "@/lib/captions";
import { done, is, part } from "./check";

const vtt = (input: unknown) => {
  const read = toVtt(input);
  return read.ok ? read.vtt : `refused: ${read.reason}`;
};

function main() {
  part("A SubRip file");
  is(
    "becomes WebVTT: dots for commas, the numbers gone, a header on top",
    vtt("1\n00:00:01,000 --> 00:00:03,500\nWelcome.\n\n2\n00:00:04,000 --> 00:00:06,000\nLet us begin.\nSecond line.\n"),
    "WEBVTT\n\n00:00:01.000 --> 00:00:03.500\nWelcome.\n\n00:00:04.000 --> 00:00:06.000\nLet us begin.\nSecond line.\n",
  );
  is("written on Windows, with a mark at the start, it reads the same", vtt("﻿1\r\n00:00:01,000 --> 00:00:02,000\r\nHello.\r\n"), "WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nHello.\n");
  is("the count of captions is told", (toVtt("1\n00:00:01,000 --> 00:00:02,000\nA\n\n2\n00:00:03,000 --> 00:00:04,000\nB") as { cues: number }).cues, 2);

  part("A WebVTT file");
  is(
    "keeps its captions, with times written in full",
    vtt("WEBVTT\n\n00:01.000 --> 00:03.000\nShort times.\n\nintro\n01:02:03.5 --> 01:02:04.0\nA named one.\n"),
    "WEBVTT\n\n00:00:01.000 --> 00:00:03.000\nShort times.\n\n01:02:03.500 --> 01:02:04.000\nA named one.\n",
  );
  is(
    "and where a caption sits on the picture",
    vtt("WEBVTT\n\n00:00:01.000 --> 00:00:02.000 line:10% align:start region:fred\nUp top.\n"),
    "WEBVTT\n\n00:00:01.000 --> 00:00:02.000 line:10% align:start\nUp top.\n",
  );
  is(
    "its notes, style sheet and regions are left out: captions and nothing else",
    vtt("WEBVTT - my file\n\nNOTE made by a tool\n\nSTYLE\n::cue { color: red }\n\nREGION\nid:fred\n\n00:00:01.000 --> 00:00:02.000\nOnly this.\n"),
    "WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nOnly this.\n",
  );

  part("The words");
  is(
    "bold, italic and underline are kept; a voice, a class and a time inside the words are taken out",
    vtt("WEBVTT\n\n00:00:01.000 --> 00:00:02.000\n<v Anna><b>Hello</b> <c.loud>there</c>, <i>you</i>.</v> One<00:00:01.500> two\n"),
    "WEBVTT\n\n00:00:01.000 --> 00:00:02.000\n<b>Hello</b> there, <i>you</i>. One two\n",
  );
  is(
    "anything else in angle brackets is shown as written, not acted on",
    vtt("WEBVTT\n\n00:00:01.000 --> 00:00:02.000\n<script>alert(1)</script> and 2 < 3\n"),
    "WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nalert(1) and 2 &lt; 3\n",
  );
  is("a caption with no words is a timed pause, and is dropped", vtt("1\n00:00:01,000 --> 00:00:02,000\n\n\n2\n00:00:03,000 --> 00:00:04,000\nWords.\n"), "WEBVTT\n\n00:00:03.000 --> 00:00:04.000\nWords.\n");

  part("A file that is not captions");
  is("nothing at all", vtt("   \n"), "refused: empty");
  is("not text", vtt(undefined), "refused: empty");
  is("a page of notes", vtt("These are my notes for lesson one.\n\nRemember the intro."), "refused: format");
  is("a header and no captions", vtt("WEBVTT\n\nNOTE nothing here\n"), "refused: format");
  is("a time that cannot be read", vtt("1\n00:00:01 --> 00:00:02\nNo fractions.\n"), "refused: format");
  is("a caption that ends before it starts", vtt("1\n00:00:05,000 --> 00:00:02,000\nBackwards.\n"), "refused: format");
  is("one good caption and one broken: the whole file is refused, not half kept", vtt("1\n00:00:01,000 --> 00:00:02,000\nGood.\n\n2\nxx --> yy\nBad.\n"), "refused: format");
  for (const broken of ["2\n00:00:03,000 -> 00:00:04,000\nMissing a dash.", "2\n00:00:03,000 00:00:04,000\nNo separator.", "A detached part of the transcript."]) {
    is(`a broken block without an arrow is refused, never silently lost: ${broken.split("\n")[0]}`, vtt(`1\n00:00:01,000 --> 00:00:02,000\nGood.\n\n${broken}`), "refused: format");
  }
  is("a forbidden timing separator in cue words refuses the whole file, never drops a line", vtt("WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nGood words.\nThis --> that.\n"), "refused: format");
  is("a file over the size one may be", vtt(`WEBVTT\n\n00:00:01.000 --> 00:00:02.000\n${"a".repeat(MAX_CAPTION_BYTES)}\n`), "refused: too_big");

  part("The languages");
  is("each is offered by its own name", [captionLabel("en"), captionLabel("pt"), captionLabel("ja")], ["English", "Português", "日本語"]);
  is("a code that is not on the list is no language", [captionLabel("xx"), captionLabel(""), captionLabel(7)], [null, null, null]);
  is("no code is offered twice", new Set(CAPTION_LANGUAGES.map((language) => language.code)).size, CAPTION_LANGUAGES.length);
  is("and each is the short code a browser knows a language by", CAPTION_LANGUAGES.every((language) => /^[a-z]{2}$/.test(language.code)), true);

  done();
}

main();
