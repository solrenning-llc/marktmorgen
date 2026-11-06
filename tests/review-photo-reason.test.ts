/**
 * 567 [GD1] (e), unit 2: a buyer's photo is taken off a review only for one of
 * the review rules (HIDE_REASONS), as a review is hidden; a photo that shows a
 * problem with the product is not a reason. The studio asks which rule.
 *
 * What fails here: the route taking a photo off without a listed reason, or the
 * studio offering it without the reasons and the words that a photo showing a
 * problem is not one.
 */
import { readFileSync } from "node:fs";
import { done, is, part } from "./check";

part("The route needs a listed reason before a photo is taken off");
const route = readFileSync("app/api/store/reviews/route.ts", "utf8");
const photo = route.slice(route.indexOf('if (action === "photo")'), route.indexOf("setReviewPhoto(statsId, productId, id, null)"));
is("refused unless the reason is on the list, before anything is changed", /if \(!isHideReason\(body\.reason\)\) return Response\.json\(\{ ok: false, error: "invalid" \}, \{ status: 400 \}\);/.test(photo), true);

part("The studio asks which rule, from the same list");
const studio = readFileSync("components/review-studio.tsx", "utf8");
is("the photo button opens the reasons", /setPicking\(picking === "photo" \? null : "photo"\)/.test(studio), true);
is("the reason is sent with the photo action", /act\("photo", \{ action: "photo", reason \}/.test(studio), true);
is("and it says a photo showing a problem is not a reason", /A photo that shows a problem with the product is not a reason to take it off/.test(studio), true);
done();
