import "./focus-scroll.css";

export default function PlatformTopicLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <div className="contents" data-topic-focus-inset>{children}</div>;
}
