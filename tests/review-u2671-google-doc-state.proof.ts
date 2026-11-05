import { readFileSync } from "node:fs";
import { done, is } from "./check";

const guide = readFileSync("docs/google-signin.md", "utf8");

is("the guide still records the feature as disabled", guide.includes("GOOGLE_SIGNIN_APPROVED` é `false"), true);
is("the guide records that the owner checked steps 2 through 7", guide.includes("O dono conferiu os passos 2 a 7"), true);
is("the guide records the renamed project", guide.includes('agora com o nome "Marktmorgen"'), true);
is(
  "the opening state no longer says that nothing was done in Google Cloud",
  guide.includes("Nada foi feito no Google Cloud"),
  false,
);

done();
