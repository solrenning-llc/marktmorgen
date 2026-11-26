/**
 * A cell that opens a quote and never closes it swallowed the rest of the file into
 * that one cell: every row under it vanished from the import without a word. The reader
 * now says where the quote opened, and the studio's import refuses the file with that
 * line instead of bringing in what is left. Synthetic data only.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseCsv } from "@/lib/csv";
import { done, is } from "./check";

const broken = parseCsv('Name,Email\n"Bob,b@x.com\nAnn,a@x.com\nCid,c@x.com\n');
is("a quote never closed is said, with the line it opened on", broken.unclosedQuote, 2);

is("a whole file says nothing", parseCsv('Name,Email\n"Bob, Jr",b@x.com\n"Ann\nLee",a@x.com\n').unclosedQuote, null);
is("a doubled quote inside a cell is not an open one", parseCsv('Name,Email\n"5"" screen",b@x.com\n').unclosedQuote, null);
is("a quote in the middle of a cell is text", parseCsv('Name,Email\nAnn "A" Lee,a@x.com\n').unclosedQuote, null);
is("the line counts lines inside earlier quoted cells", parseCsv('Name,Email\n"Ann\nLee",a@x.com\n"Bob,b@x.com\n').unclosedQuote, 4);

const tool = readFileSync(join(process.cwd(), "components/import-tool.tsx"), "utf8");
is("the import refuses such a file and names the line", /read\.unclosedQuote !== null[\s\S]{0,400}read\.unclosedQuote/.test(tool), true);

done();
