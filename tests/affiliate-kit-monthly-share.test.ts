import { kitMonthly } from "@/lib/affiliate-kit-rules";
import { done, is } from "./check";

is("one quarter of 20 monthly units is 5", kitMonthly(20), 5);
is("one quarter of 100 monthly units is 25", kitMonthly(100), 25);
is("a partial quarter rounds down to whole drafts", kitMonthly(23), 5);

done();
