/**
 * 628 [HN4](b), unit 1: the course's "More from" shelf (lib/course-shelf-
 * rules.ts, lib/course.ts): at most six of the creator's products, each once,
 * never the course itself; a student sees only listed products they do not
 * own, and nothing when what they own cannot be read.
 */
import { MAX_SHELF, readShelf, shelfFor } from "@/lib/course-shelf-rules";
import { editCourse, emptyCourse, parseCourse } from "@/lib/course";
import { done, is, part } from "./check";

const ids = ["prod0001", "prod0002", "prod0003", "prod0004", "prod0005", "prod0006", "prod0007"];

part("What a shelf may hold");
is("at most six", readShelf(ids).length, MAX_SHELF);
is("each once, in the creator's order", readShelf(["prod0002", "prod0001", "prod0002"]), ["prod0002", "prod0001"]);
is("never the course's own product", readShelf(["course01", "prod0001"], "course01"), ["prod0001"]);
is("anything that is not a product id is left out", readShelf(["../x", 42, "AB", "prod0001"]), ["prod0001"]);
is("not a list: empty", readShelf("prod0001"), []);

part("Kept on the course, and changed by the studio's edit");
const course = emptyCourse();
is("a new course has none", course.shelf, undefined);
const set = editCourse(course, { op: "shelf", products: ["prod0001", "course01", "prod0002"], courseProductId: "course01" });
is("saved without the course itself", set.ok ? set.course.shelf : null, ["prod0001", "prod0002"]);
is("read back the same", set.ok ? parseCourse(JSON.stringify(set.course))?.shelf : null, ["prod0001", "prod0002"]);
const cleared = set.ok ? editCourse(set.course, { op: "shelf", products: [], courseProductId: "course01" }) : null;
is("cleared: no shelf at all", cleared?.ok ? "shelf" in cleared.course : null, false);

part("What a student sees");
const listed = new Set(["prod0001", "prod0002", "prod0003"]);
const shelf = ["prod0003", "prod0009", "prod0001", "prod0002"];
is("listed products only, in order, less what they own", shelfFor(shelf, listed, new Set(["prod0002"]), "course01"), ["prod0003", "prod0001"]);
is("a product no longer listed (a draft or gone) is not shown", shelfFor(["prod0009"], listed, new Set(), "course01"), []);
is("what they own unknown: nothing", shelfFor(shelf, listed, null, "course01"), []);
is("never the course itself", shelfFor(["course01", "prod0001"], new Set([...listed, "course01"]), new Set(), "course01"), ["prod0001"]);

done();
