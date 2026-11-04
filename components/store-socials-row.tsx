import { Icon } from "@/components/icons";
import { type BlockWords } from "@/lib/buyer-words/blocks";
import { SOCIALS, type Social } from "@/lib/store-socials";

/**
 * The creator's profiles elsewhere, under their name on the store page
 * (lib/store-socials.ts): each one a chip with a plain icon and the
 * network's name, never a company's logo. Opens in a new tab; rel="me"
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
          return (
            <li key={social.url}>
              <a
                href={social.url}
                {...(social.network === "email" ? {} : { target: "_blank", rel: "me noopener" })}
                aria-label={own ? undefined : words.socialOn(name, spec.label)}
                className="st-social"
              >
                <Icon name={spec.icon} size={16} />
                <span>{label}</span>
              </a>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
