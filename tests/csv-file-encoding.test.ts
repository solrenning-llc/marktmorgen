/**
 * A spreadsheet saved by Excel as "CSV (Comma delimited)" is written in the computer's own code page (Windows-1252 in
 * the Americas and Western Europe), not in UTF-8. Read as UTF-8, every accented letter in it became the replacement
 * character, and the import kept "Jos� Concei��o" as the contact's name, a product's title or a sequence's subject,
 * without a word (synthetic only).
 *
 * The studio's two file readers (components/import-tool.tsx, components/sequence-import-box.tsx) read the file's bytes
 * with decodeCsvBytes (lib/csv.ts): UTF-8 when the bytes are UTF-8 (with or without Excel's byte-order mark), UTF-16
 * when a byte-order mark says so (Excel's "Unicode Text"), and Windows-1252 otherwise, so every letter arrives as typed.
 */
import { readFileSync } from "node:fs";
import { decodeCsvBytes, parseCsv } from "@/lib/csv";
import { done, is, part } from "./check";

const read = (file: string) => readFileSync(file, "utf8");
const bytes = (...values: number[]) => Uint8Array.from(values);
const ascii = (text: string) => [...text].map((c) => c.charCodeAt(0));

part("Excel's CSV (Comma delimited), in Windows-1252");
// "email,name\r\nana@example.com,José Conceição — “VIP”\r\n" as Windows-1252 writes it: é E9, ç E7, ã E3, — 97, “ 93, ” 94.
const ansi = bytes(...ascii("email,name\r\nana@example.com,Jos"), 0xe9, ...ascii(" Concei"), 0xe7, 0xe3, ...ascii("o "), 0x97, 0x20, 0x93, ...ascii("VIP"), 0x94, 0x0d, 0x0a);
const fromAnsi = parseCsv(decodeCsvBytes(ansi));
is("the accented name arrives as typed", fromAnsi.rows[0]?.[1], "José Conceição — “VIP”");
is("and nothing is turned into the replacement character", decodeCsvBytes(ansi).includes("�"), false);

part("UTF-8, with and without Excel's byte-order mark");
const utf8 = new TextEncoder().encode("email,name\nana@example.com,José Conceição 😀\n");
is("UTF-8 read as UTF-8", parseCsv(decodeCsvBytes(utf8)).rows[0]?.[1], "José Conceição 😀");
const withMark = Uint8Array.from([0xef, 0xbb, 0xbf, ...utf8]);
const marked = parseCsv(decodeCsvBytes(withMark));
is("the mark never becomes part of the first column's name", [marked.header[0], marked.rows[0]?.[1]], ["email", "José Conceição 😀"]);

part("Excel's Unicode Text, in UTF-16 with its mark");
const text = "email\tname\r\nana@example.com\tJosé\r\n";
const le = [0xff, 0xfe];
for (let i = 0; i < text.length; i += 1) le.push(text.charCodeAt(i) & 0xff, text.charCodeAt(i) >> 8);
const sixteen = parseCsv(decodeCsvBytes(Uint8Array.from(le)));
is("read as UTF-16, tabs between the cells", [sixteen.separator, sixteen.header[0], sixteen.rows[0]?.[1]], ["\t", "email", "José"]);

part("The studio's file readers read the bytes this way");
for (const file of ["components/import-tool.tsx", "components/sequence-import-box.tsx"]) {
  const source = read(file);
  is(`${file} reads the file's bytes with decodeCsvBytes, never file.text()`, [source.includes("decodeCsvBytes(new Uint8Array(await file.arrayBuffer()))"), source.includes("file.text()")], [true, false]);
}

done();
