import { heldToFacts } from "@/lib/store-assistant-rules";
import { done, is, part } from "./check";

part("Letters with a stroke in both cases");

is("lowercase and uppercase strokes cannot hide coupon or discount", [
  heldToFacts("Use the cupøn.", "Pottery course."),
  heldToFacts("Use the cupØn.", "Pottery course."),
  heldToFacts("A điscount.", "Pottery course."),
  heldToFacts("A Điscount.", "Pottery course."),
], [false, false, false, false]);

is("honest uppercase words and a store's own spelling remain allowed", [
  heldToFacts("KRØNER AND ŁÓDŹ.", "Pottery course."),
  heldToFacts("A Điscount.", "A Điscount."),
], [true, true]);

done();
