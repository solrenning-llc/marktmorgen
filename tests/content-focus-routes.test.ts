import assert from "node:assert/strict";
import { test } from "node:test";
import { renderedContentDeclarations } from "./e2e/skip-content-focus.mjs";

for (const development of [false, true]) test(`all route and shared main declarations render a native focus target (${development ? "development" : "production"})`, async () => {
  const mains = await renderedContentDeclarations(process.cwd(), development);
  const missing = mains.filter(main => !/\btabindex="-1"/.test(main.html.match(/<main\b[^>]*>/)![0])).map(main => main.route);
  assert.deepEqual(missing, [], "every real main#content declaration must emit tabindex=-1 before any hydration");
});

test("the common boundary changes only the destination's tabindex", async () => {
  const { contentMainProps } = await import("@/lib/content-jsx/main-props");
  const child = { name: "untouched child" }, ref = { current: null };
  const props = Object.freeze({ id: "content", children: child, ref, className: "same-layout", tabIndex: 0, "data-state": "kept" });
  const result = contentMainProps("main", props) as typeof props;
  assert.deepEqual(result, { ...props, tabIndex: -1 });
  assert.equal(result.children, child);
  assert.equal(result.ref, ref);
  assert.equal(props.tabIndex, 0, "frozen input is not mutated");
  const already = Object.freeze({ id: "content", tabIndex: -1 });
  assert.equal(contentMainProps("main", already), already);
  for (const type of ["div", "a", () => null, Symbol.for("react.fragment")]) assert.equal(contentMainProps(type, props), props);
  for (const value of [null, undefined, false, "text", { id: "another-main" }, { tabIndex: 0 }]) assert.equal(contentMainProps("main", value), value);
});

test("React keys, refs, fragments and ordinary elements keep their own runtime behavior", async () => {
  const shared = await import("@/lib/content-jsx/jsx-runtime");
  const react = await import("react/jsx-runtime");
  const development = await import("@/lib/content-jsx/jsx-dev-runtime");
  const reactDevelopment = await import("react/jsx-dev-runtime");
  assert.equal(shared.Fragment, react.Fragment);
  assert.equal(development.Fragment, reactDevelopment.Fragment);
  for (const type of ["div", "input", "main"] as const) {
    const ref = { current: null };
    const props = () => ({ id: "not-content", children: "Same text", ref });
    for (const method of ["jsx", "jsxs"] as const) {
      const actualProps = props(), expectedProps = props();
      if (method === "jsxs") { actualProps.children = ["Same text"] as unknown as string; expectedProps.children = ["Same text"] as unknown as string; }
      const actual = shared[method](type, actualProps, "stable-key"), expected = react[method](type, expectedProps, "stable-key");
      assert.equal(actual.type, expected.type);
      assert.equal(actual.key, expected.key);
      assert.deepEqual(actual.props, expected.props);
    }
    const actual = development.jsxDEV(type, props(), "dev-key", false);
    const expected = reactDevelopment.jsxDEV(type, props(), "dev-key", false);
    assert.equal(actual.type, expected.type);
    assert.equal(actual.key, expected.key);
    assert.deepEqual(actual.props, expected.props);
  }
});
