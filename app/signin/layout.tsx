import "../home.css";
import "./focus-scroll.css";
import { SiteFooter } from "@/components/site-footer";
import { MORNING_FONTS } from "@/components/morning-fonts";
import { SkipLink } from "@/components/skip-link";

/* Logging in is a task: the pages under /signin close with the slim footer.
   Every step of it, in the home page's morning look (VS1, app/home.css .hm-page). */
export default function SignInLayout({ children }: LayoutProps<"/signin">) {
  return (
    <div className={`${MORNING_FONTS} hm hm-page`}>
      <SkipLink />
      {children}
      <SiteFooter variant="slim" />
    </div>
  );
}
