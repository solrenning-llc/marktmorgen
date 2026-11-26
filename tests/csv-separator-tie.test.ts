/**
 * When a file's first line has as many ";" as "," outside quotes (a European
 * header such as "Email;Name, as typed"), the reader chose "," and split every
 * row in the wrong place, so no row read as an email. A tie is now settled by the
 * lines below: the separator that gives the same number of cells on them as on
 * the first line. Synthetic data only.
 */
import { detectSeparator, parseCsv } from "@/lib/csv";
import { done, is } from "./check";

const tied = parseCsv("Email;Name, as typed\r\nzoé@x.com;Zoé, Dupont\r\nann@x.com;Ann\r\n");
is("a tie is settled by the rows below", tied.separator, ";");
is("so the header reads", tied.header, ["Email", "Name, as typed"]);
is("and every row", tied.rows, [["zoé@x.com", "Zoé, Dupont"], ["ann@x.com", "Ann"]]);

is("the other way round", detectSeparator("email,name; nick\na@x.com,Ann\nb@x.com,Bo; B\n"), ",");
is("a clear majority is kept as before", detectSeparator("a;b;c,d\n1;2;3\n"), ";");
is("a comma file is a comma file", detectSeparator("email,name\na@x.com,Ann\n"), ",");
is("one line only, a tie stays a comma", detectSeparator("a;b,c"), ",");
is("quotes on the rows are not counted", detectSeparator("Email;Name, as typed\n\"x;y@z.com\";\"Ann, Lee\"\nb@x.com;Bo\n"), ";");

// Every row with one of each, so the rows cannot tell (Codex X3 on #4436): the columns do. The candidate whose
// header names an email column, and whose rows hold an address in a cell of their own, is the file's separator.
const even = "Email;Name, as typed\nana@example.test;Doe, Ana\nbo@example.test;Lee, Bo\n";
is("rows that cannot tell: settled by the email column", detectSeparator(even), ";");
is("so the header reads", parseCsv(even).header, ["Email", "Name, as typed"]);
is("and every row", parseCsv(even).rows, [["ana@example.test", "Doe, Ana"], ["bo@example.test", "Lee, Bo"]]);
is("the same the other way round", detectSeparator("Email,Name; as typed\nana@example.test,Doe; Ana\nbo@example.test,Lee; Bo\n"), ",");
is("an address column named otherwise is still found by its rows", detectSeparator("Contact;Name, as typed\nana@example.test;Doe, Ana\n"), ";");
is("the header alone settles it on a file with no rows yet", detectSeparator("E-mail;Name, as typed"), ";");

done();
