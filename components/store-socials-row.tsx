import { Icon } from "@/components/icons";
import { NewTab } from "@/components/new-tab";
import { type BlockWords } from "@/lib/buyer-words/blocks";
import { SOCIALS, type Social } from "@/lib/store-socials";

/**
 * The creator's profiles elsewhere, under their name on the store page
 * (lib/store-socials.ts): each one a chip with a plain icon and the
 * network's name, never a company's logo. Opens in a new tab, and says so; rel="me"
 * tells the networks that support it that the store and the profile are
 * the same person's.
 */
export function StoreSocialsRow({ socials, name, words }: { socials: Social[]; name: string; words: BlockWords }) {
  if (socials.length === 0) return null;
  return (
    <nav aria-label={words.socialsLabel} className="mx-auto mt-3 max-w-lg">
      <ul className="flex flex-wrap justify-center gap-2">
        {socials.map((social) => {
          const spec = SOCIALS[social.network];
          const label =
            social.network === "email" ? words.socialEmail : social.network === "website" ? words.socialWebsite : spec.label;
          const own = social.network === "email" || social.network === "website";
          const away = social.network !== "email";
          return (
            <li key={social.url}>
              {/*
                Named by its words, not by an aria-label, which would replace
                them and hide the new-tab note (3.2.5, G201): a network reads
                "<name> on Instagram (opens in a new tab)", its visible word
                inside the name (2.5.3).
              */}
              <a
                href={social.url}
                {...(away ? { target: "_blank", rel: "me noopener" } : {})}
                className="st-social"
              >
                <Icon name={spec.icon} size={16} />
                {own ? <span>{label}</span> : <><span aria-hidden="true">{label}</span><span className="sr-only">{words.socialOn(name, spec.label)}</span></>}
                {away ? <NewTab /> : null}
              </a>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
