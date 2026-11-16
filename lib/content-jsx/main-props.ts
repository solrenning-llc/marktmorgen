/** Keep the native skip-link destination focusable in the server HTML too. */
export function contentMainProps(type: unknown, props: unknown): unknown {
  if (type !== "main" || props === null || typeof props !== "object") return props;
  const id = Object.getOwnPropertyDescriptor(props, "id");
  if (!id || !("value" in id) || id.value !== "content") return props;
  const tabIndex = Object.getOwnPropertyDescriptor(props, "tabIndex");
  if (tabIndex && "value" in tabIndex && tabIndex.value === -1) return props;
  return { ...props, tabIndex: -1 };
}
