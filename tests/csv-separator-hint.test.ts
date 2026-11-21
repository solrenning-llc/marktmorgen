/**
 * Excel in much of Europe and Brazil saves (and reads) a "sep=;" first line naming the
 * file's separator. It is not the header: the reader takes the separator from it, drops
 * it, and keeps the file's own line numbers. Before, it became the header ("sep=", "")
 * and the real header a data row, so no column could be chosen, and the line counted
 * toward the import's limit (a file of exactly the limit was refused as over it).
 * Synthetic data only.
 */
import { parseCsv } from "@/lib/csv";
import { done, is } from "./check";

const semi = parseCsv("sep=;\r\nE-mail;Nom\r\nzoe@x.com;Zoé\r\n");
is("a sep=; line names the separator", semi.separator, ";");
is("and is not the header", semi.header, ["E-mail", "Nom"]);
is("the rows are the file's rows", semi.rows, [["zoe@x.com", "Zoé"]]);
is("line numbers stay the file's", semi.lines, [3]);

const withBom = parseCsv("﻿sep=,\nemail;name, last\na@x.com;Ann, Lee\n");
is("after a byte-order mark too, and it wins over counting", [withBom.separator, withBom.header], [",", ["email;name", "last"]]);

const tab = parseCsv("sep=\t\nemail\tname\na@x.com\tAnn\n");
is("a tab named the same way", [tab.separator, tab.rows], ["\t", [["a@x.com", "Ann"]]]);

const limit = 3;
const rows = ["email", "a@x.com", "b@x.com", "c@x.com"].join("\n");
is("a file at the limit is not over it because of the line", parseCsv(`sep=,\n${rows}\n`, limit).truncated, false);
is("one past the limit still is", parseCsv(`sep=,\n${rows}\nd@x.com\n`, limit).truncated, true);

const plain = parseCsv("sep,name\n1,Ann\n");
is("a header that only starts with sep is a header", plain.header, ["sep", "name"]);

done();
