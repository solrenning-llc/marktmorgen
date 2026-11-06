/** Isolated RED for the course edit: current pure shelf helper, unchanged pre-feature course module. */
import { editCourse,emptyCourse } from "@/lib/course";
import { shelfFor } from "@/lib/course-shelf-rules";
import { done,is } from "./check";
const source=emptyCourse();const set=editCourse(source,{op:"shelf",products:["prod0001"],courseProductId:"course01"});
is("new edit is supported",set?.ok,true);
is("new edit keeps the shelf",set?.ok?set.course.shelf:null,["prod0001"]);
const clear=set?.ok?editCourse(set.course,{op:"shelf",products:[],courseProductId:"course01"}):null;
is("clear removes the shelf field",clear?.ok?"shelf" in clear.course:null,false);
is("control: unknown ownership never recommends",shelfFor(["prod0001"],new Set(["prod0001"]),null,"course01"),[]);
done();
