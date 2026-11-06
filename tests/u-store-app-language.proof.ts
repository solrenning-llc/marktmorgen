/**
 * Evidence that the installable web app of a store always declares English
 * and uses an English fallback description, even when the store speaks one
 * of the other six buyer languages.
 */
import { storeManifest } from "@/lib/store-app";
import { DEFAULT_LOOK } from "@/lib/store-look";
import type { Store } from "@/lib/store";
import { wordsIn } from "@/lib/buyer-words";
import { LANGUAGES, LANGUAGE_CODES, type LanguageCode } from "@/lib/store-language";
import { done, is, part } from "./check";

const named = "Casa do Farol";
const store = (language: LanguageCode, bio = "") =>
  ({
    handle: "casa-do-farol",
    name: named,
    bio,
    language,
    currency: "eur",
    look: { ...DEFAULT_LOOK },
    photoId: null,
    domain: null,
  }) as Store;

part("Every installable store declares its own buyer language");
for (const language of LANGUAGE_CODES) {
  const manifest = storeManifest(store(language), "marktmorgen.com");
  is(`${language}: the manifest language matches the store page locale`, manifest.lang, LANGUAGES[language].locale);
  is(`${language}: the default description uses the existing buyer words`, manifest.description, wordsIn(language).storeDescription(named));
}

part("Creator words and app identity stay unchanged");
const creatorBio = "Receitas simples, escritas pela criadora.";
const manifest = storeManifest(store("pt", creatorBio), "marktmorgen.com");
is("the creator's own biography is preserved word for word", manifest.description, creatorBio);
is("the full store name is preserved", manifest.name, named);
is("the short store name stays derived from the creator's name", manifest.short_name, "Casa");
is("the app opens on the store", manifest.start_url, "/@casa-do-farol");
is("the app scope stays on the store", manifest.scope, "/@casa-do-farol");
is("the app remains standalone", manifest.display, "standalone");
is("the store theme remains the source of the background", manifest.background_color, "#fbfaf7");
is("the store theme remains the source of the phone bar", manifest.theme_color, "#fbfaf7");
is("the standard shopping category is preserved", manifest.categories, ["shopping"]);
is("the same three app icons remain", manifest.icons.map((icon) => `${icon.sizes}:${icon.purpose}`), ["192x192:any", "512x512:any", "512x512:maskable"]);

done();
