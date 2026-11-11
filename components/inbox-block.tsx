"use client";
export function InboxBlock(props: { id: string; post: (body: Record<string, unknown>) => Promise<Record<string, unknown>> }) {
  void props;
  return <div data-inbox-block />;
}
