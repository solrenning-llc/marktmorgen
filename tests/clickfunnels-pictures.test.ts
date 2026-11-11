/**
 * 394 [CX5], unit 1: a saved page's pictures, by the path the browser's
 * "complete" save gave them in its own folder (lib/clickfunnels-pictures.ts),
 * matched to files the creator chooses. Nothing is fetched from ClickFunnels'
 * servers: a picture that is only an address there has no local path. Pure.
 */
import { convertSavedPage } from "@/lib/clickfunnels-page";
import { MAX_SAVED_PICTURES, matchSavedPictures, savedPictureRef } from "@/lib/clickfunnels-pictures";
import { done, is, part } from "./check";

part("A picture's path inside the saved page's folder");
is("a relative path", savedPictureRef("Sales Page_files/hero.jpg"), "Sales Page_files/hero.jpg");
is("dot-slash and a query dropped", savedPictureRef("./Sales%20Page_files/hero.png?v=2#x"), "Sales Page_files/hero.png");
for (const remote of ["https://images.clickfunnels.com/hero.jpg", "//cdn.example.com/a.png", "/abs/a.png", "data:image/png;base64,AAAA", "javascript:alert(1)", "C:\\pics\\a.png", "file:///etc/a.png"]) {
  is(`not local: ${remote.slice(0, 30)}`, savedPictureRef(remote), null);
}
for (const odd of ["", "hero.jpg", "x_files/../../etc/a.png", "x_files/./a.png", "x_files//a.png", "x_files/a.svg", "x_files/a.txt", "x_files/%E0.png", "x_files/a\u202e.png"]) {
  is(`refused: ${JSON.stringify(odd)}`, savedPictureRef(odd), null);
}

part("Matched to the chosen files");
const refs = ["Page_files/hero.jpg", "Page_files/team.webp", null, "Page_files/hero.jpg", "Page_files/gone.png"];
const folder = [
  { name: "hero.jpg", path: "Page_files/hero.jpg" },
  { name: "team.webp", path: "Page_files/team.webp" },
  { name: "other.png", path: "Page_files/other.png" },
];
is("by the folder's own paths; each picture once", matchSavedPictures(refs, folder), {
  matched: [{ ref: "Page_files/hero.jpg", file: 0 }, { ref: "Page_files/team.webp", file: 1 }],
  missing: ["Page_files/gone.png"],
});
const loose = [{ name: "hero.jpg", path: "" }, { name: "team.webp", path: "" }];
is("files chosen one by one match by their name", matchSavedPictures(["Page_files/hero.jpg", "Page_files/team.webp"], loose).matched, [{ ref: "Page_files/hero.jpg", file: 0 }, { ref: "Page_files/team.webp", file: 1 }]);
const twice = [{ name: "hero.jpg", path: "" }, { name: "hero.jpg", path: "" }];
is("two chosen files with one name match nothing", matchSavedPictures(["Page_files/hero.jpg"], twice), { matched: [], missing: ["Page_files/hero.jpg"] });
is("two pictures with one name in different folders match nothing by name", matchSavedPictures(["A_files/x.png", "B_files/x.png"], [{ name: "x.png", path: "" }]), { matched: [], missing: ["A_files/x.png", "B_files/x.png"] });

part("The converter keeps each picture's local path");
const html = `<html><head><title>Offer</title></head><body>
<h1>Learn pottery</h1>
<img src="Offer_files/hero.jpg" alt="A bowl on the wheel">
<img src="https://images.clickfunnels.com/x/team.png" alt="Team">
<img src="Offer_files/pixel.gif" width="1" height="1">
<p>Start this week.</p></body></html>`;
const draft = convertSavedPage(html, "Offer.html");
is("local and remote, tracking pixels left out", draft.pictures, [
  { ref: "Offer_files/hero.jpg", alt: "A bowl on the wheel" },
  { ref: null, alt: "Team" },
]);
const many = `<body>${Array.from({ length: MAX_SAVED_PICTURES + 5 }, (_, i) => `<img src="P_files/p${i}.png" alt="">`).join("")}<p>Text</p></body>`;
is(`at most ${MAX_SAVED_PICTURES} kept`, convertSavedPage(many).pictures.length, MAX_SAVED_PICTURES);
done();
