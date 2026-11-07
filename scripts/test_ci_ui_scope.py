"""Synthetic rules of scripts/ci_ui_scope.py; run by the browser-only workflows before deciding."""
import os
import subprocess
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from ci_ui_scope import (GitTree, Uncertain, changed_paths, reachable,  # noqa: E402
                         suites_unaffected, unaffected_between)
from ci_documentation_scope import requires_suite  # noqa: E402
import ci_ui_scope as ui  # noqa: E402

# The repository's own reviewed bundlers, kept before the synthetic tree below adds its
# stand-in suite (tests/e2e/suite.mjs), which bundles a named file the same way.
REAL_REVIEWED = ui.REVIEWED_COMPUTED
SYNTHETIC_REVIEWED = REAL_REVIEWED | {"tests/e2e/suite.mjs"}


class WithSyntheticSuite(unittest.TestCase):
    def setUp(self):
        ui.REVIEWED_COMPUTED = SYNTHETIC_REVIEWED
        self.addCleanup(setattr, ui, "REVIEWED_COMPUTED", REAL_REVIEWED)

A, B = "a" * 40, "b" * 40

BASE = {
    "package.json": '{"scripts": {"build": "next build"}}',
    "tsconfig.json": '{"compilerOptions": {"jsxImportSource": "@/lib/jsx"}}',
    "next.config.ts": 'import { policy } from "./lib/csp";',
    "lib/csp.ts": "export const policy = 1;",
    "lib/jsx/jsx-runtime.ts": "export const jsx = 1;",
    "app/page.tsx": 'import { a } from "@/lib/a";\nimport "./page.css";\nexport default a;',
    "app/page.css": '@import "../lib/theme.css";\n.a { background: url("../lib/mark.css"); }',
    "lib/theme.css": "",
    "lib/mark.css": "",
    "lib/a.ts": 'export * from "./a-parts.js";\n/** held by tests/a.test.ts; an import (lib/z.ts) */',
    "lib/a-parts.ts": "export const a = 1;",
    "lib/b.ts": 'import { a } from "./a";\nexport const b = a;',
    "lib/fonts/a.ttf": "",
    "tests/a.test.ts": 'import { b } from "@/lib/b";',
    "tests/fixture.ts": "export const f = 1;",
    "tests/e2e/suite.mjs": 'import { f } from "../fixture";\nawait build({ entryPoints: [join(root, "lib/bundled.ts")] });\nconst m = await import(bundle);',
    "lib/bundled.ts": 'import "./bundled-dep";',
    "lib/bundled-dep.ts": "export {};",
    "docs/data.json": "{}",
    "docs/a.md": "",
    "scripts/report.mjs": "",
    "cli/run.mjs": "",
}


def tree(files):
    return (list(files), lambda path: files[path])


def unaffected(changed, *trees):
    return suites_unaffected(changed, [tree(t) for t in (trees or (BASE,))])


def change(path, status="M", before="100644", after="100644"):
    if status == "A":
        before = "000000"
    if status == "D":
        after = "000000"
    return (":" + before + " " + after + " " + A + " " + B + " " + status + "\0" + path + "\0").encode()


class Graph(WithSyntheticSuite):
    def test_follows_aliases_reexports_js_to_ts_css_and_the_jsx_runtime(self):
        graph = reachable(*tree(BASE))
        for path in ("lib/a.ts", "lib/a-parts.ts", "lib/theme.css", "lib/mark.css",
                     "lib/jsx/jsx-runtime.ts", "lib/csp.ts", "tests/fixture.ts"):
            self.assertIn(path, graph)

    def test_a_suite_bundling_a_named_file_follows_that_file_s_imports(self):
        self.assertIn("lib/bundled-dep.ts", reachable(*tree(BASE)))

    def test_a_name_in_application_prose_does_not_load_what_that_file_imports(self):
        graph = reachable(*tree(BASE))
        self.assertIn("tests/a.test.ts", graph)  # named in lib/a.ts: counted, conservatively
        self.assertNotIn("lib/b.ts", graph)  # but what it imports is not

    def test_skippable_only_when_nothing_reaches_it(self):
        self.assertTrue(unaffected(["lib/b.ts"]))
        self.assertTrue(unaffected(["docs/data.json", "scripts/report.mjs", "docs/a.md"]))
        for path in ("lib/a.ts", "lib/a-parts.ts", "tests/fixture.ts", "tests/a.test.ts",
                     "lib/bundled-dep.ts", "lib/csp.ts", "lib/theme.css"):
            with self.subTest(path=path):
                self.assertFalse(unaffected([path]))

    def test_paths_outside_the_reviewed_folders_or_not_source_always_run(self):
        for path in ("app/page.tsx", "components/x.tsx", "public/a.png", "styles/a.css",
                     "tests/e2e/new.mjs", "tooling/screen-reader/a.mjs", ".github/workflows/a.yml",
                     "scripts/ci-build.mjs", "scripts/ci_ui_scope.py", "scripts/test_ci_ui_scope.py",
                     "package.json", "package-lock.json", "tsconfig.json", "next.config.ts",
                     "proxy.ts", "cli/run.mjs", "infra/a.tf", "vercel.json",
                     "lib/fonts/a.ttf", "docs/image.svg", "tests/fixture.snap"):
            with self.subTest(path=path):
                self.assertFalse(unaffected([path]))

    def test_one_reaching_file_runs_the_whole_change(self):
        self.assertFalse(unaffected(["lib/b.ts", "lib/a.ts"]))

    def test_every_tree_counts_deleted_and_newly_imported_files(self):
        head = dict(BASE)
        del head["lib/a-parts.ts"]
        head["lib/a.ts"] = "export const a = 1;"
        self.assertFalse(unaffected(["lib/a-parts.ts"], BASE, head))
        merged = dict(BASE)
        merged["app/other.tsx"] = 'import "@/lib/b";'
        self.assertFalse(unaffected(["lib/b.ts"], BASE, BASE, merged))

    def test_uncertainty_raises(self):
        cases = {
            "computed import": {"lib/a.ts": "const m = await import(name);"},
            "computed require": {"lib/a.ts": "const m = require(name);"},
            # Codex G on #3037: a page or a component it re-exports may import a library
            # file whose name is computed; the graph cannot see it, so it must not skip.
            "computed import in a page": {"app/page.tsx": "const leaf = 'b';\nexport default (await import(`../lib/${leaf}.ts`)).b;"},
            # Codex G's residual on #3037: a string prefix joined to a variable reads as a
            # literal "../lib/" and resolves to lib/index.*, hiding the real target.
            "concatenated import in a page": {"app/page.tsx": "export default (await import('../lib/' + leaf + '.ts')).b;",
                                              "lib/index.ts": "export const unused = true;"},
            "concatenated require in a component": {"components/c.tsx": "export const c = require('../lib/' + leaf);",
                                                    "lib/index.ts": "export const unused = true;",
                                                    "app/page.tsx": 'import { c } from "@/components/c";\nexport default c;'},
            # Codex G's third return on #3037: resolving a computed name is a computed import too.
            "computed require.resolve in a page": {"app/page.tsx": "import { readFileSync } from 'node:fs';\nexport default JSON.parse(readFileSync(require.resolve(spec), 'utf8')).b;"},
            "computed import.meta.resolve": {"app/page.tsx": "export default import.meta.resolve(spec);"},
            "computed new URL from import.meta.url": {"components/c.tsx": "export const c = new URL(spec, import.meta.url);",
                                                      "app/page.tsx": 'import { c } from "@/components/c";\nexport default c;'},
            # Codex G's fourth return on #3037: a quoted prefix joined to more, in every
            # resolving form, is computed; one rule now covers all call forms at once.
            "concatenated import.meta.resolve": {"app/page.tsx": "export default import.meta.resolve('../lib/' + leaf);"},
            "concatenated new URL": {"components/c.tsx": "export const c = new URL('../lib/' + leaf, import.meta.url);",
                                     "app/page.tsx": 'import { c } from "@/components/c";\nexport default c;'},
            "concatenated require.resolve": {"app/page.tsx": "export default require.resolve('../lib/' + leaf);"},
            "template with a hole": {"app/page.tsx": "export default await import(`../lib/${leaf}`);"},
            # Codex G's fifth return on #3037: a ";" inside a string must not end the search
            # for import.meta.url; a file that uses import.meta.url and builds a URL from
            # anything but one whole literal is computed, wherever the ";" falls.
            "semicolon inside a string before import.meta.url": {"app/page.tsx": "export default new URL(\n  'discard;'.slice(0, 0) + '../lib/' + leaf + '.json',\n  import.meta.url\n);"},
            "same in a re-exported component": {"components/c.tsx": "export const c = new URL(\n  'x;'.slice(0, 0) + '../lib/' + leaf,\n  import.meta.url);",
                                                "app/page.tsx": 'import { c } from "@/components/c";\nexport default c;'},
            "method on the specifier": {"app/page.tsx": "export default await import('../lib/b'.concat(x));"},
            # Claude 5 on #3037: a comment at the start of a line, a generator method line
            # starting with "*", and a createRequire bound to another name hid the import.
            "block comment before a computed import": {"app/page.tsx": "/* c8 ignore next */ const m = await import(`../lib/${leaf}.js`);\nexport default m;"},
            "generator method line starting with *": {"app/page.tsx": "export default {\n  *items() { yield require(`../lib/${leaf}.js`).text; },\n};"},
            "createRequire bound to another name": {"app/page.tsx": "import { createRequire } from 'node:module';\nconst load = createRequire(import.meta.url);\nexport default load('../lib/' + leaf + '.js');"},
            "createRequire imported under another name": {"app/page.tsx": "import { createRequire as make } from 'node:module';\nconst require = make(import.meta.url);\nexport default require(`../lib/${leaf}.js`).b;"},
            "require passed on as a value": {"app/page.tsx": "const load = require;\nexport default load('../lib/' + leaf);"},
            "computed import in a component": {"components/c.tsx": "export const c = await import(`../lib/${leaf}.ts`);",
                                               "app/page.tsx": 'import { c } from "@/components/c";\nexport default c;'},
            "unresolved import": {"app/page.tsx": 'import "@/lib/missing";'},
            "leaving the repository": {"app/page.tsx": 'import "../../outside";'},
            "absolute specifier": {"app/page.tsx": 'import "/etc/x";'},
            "directory listing": {"lib/a.ts": "readdirSync(folder)"},
            "install hook": {"package.json": '{"scripts": {"postinstall": "node scripts/report.mjs"}}'},
            "bad tsconfig": {"tsconfig.json": "{"},
            "unknown jsx source": {"tsconfig.json": '{"compilerOptions": {"jsxImportSource": "preact"}}'},
        }
        for name, replacement in cases.items():
            with self.subTest(case=name):
                broken = dict(BASE, **replacement)
                with self.assertRaises(Uncertain):
                    unaffected(["lib/b.ts"], broken)

    def test_only_the_reviewed_bundlers_may_import_a_computed_name(self):
        # The four end-to-end runners load bundles built from files they name in strings,
        # which the graph follows; any other computed import anywhere is uncertain. A new
        # one has to be reviewed and added by name, never exempted by folder.
        here = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
        found = set()
        for top in ("app", "components", "public", "styles", "tests/e2e", "tooling", ".github", "lib"):
            for folder, _, names in os.walk(os.path.join(here, top)):
                for name in names:
                    path = os.path.relpath(os.path.join(folder, name), here)
                    if not path.endswith(ui.TEXT):
                        continue
                    with open(os.path.join(here, path), encoding="utf8") as handle:
                        code = "\n".join(ui.code_lines(handle.read()))
                    if ui.computed(code):
                        found.add(path)
        self.assertEqual(found, set(REAL_REVIEWED))

    def test_a_whole_literal_dynamic_import_is_still_followed(self):
        for code in ("await import('../lib/b')", "await import( '../lib/b' )", "require('../lib/b')",
                     "require.resolve('../lib/b')", "new URL('./a.png', import.meta.url)",
                     "import.meta.resolve('../lib/b')", 'require("playwright-core")[engine]',
                     "new URL('./a.png' , import.meta.url)",
                     "await import('../lib/b', { with: {} })"):
            with self.subTest(code=code):
                self.assertFalse(ui.computed(code))

    def test_unreadable_file_raises(self):
        files = list(BASE) + ["lib/ghost.ts"]
        broken = dict(BASE, **{"app/page.tsx": 'import "@/lib/ghost";'})
        with self.assertRaises(Uncertain):
            suites_unaffected(["lib/b.ts"], [(files, lambda path: broken[path])])

    def test_comment_lines_are_not_computed_imports(self):
        quiet = dict(BASE, **{"lib/a.ts": "/**\n * an import (lib/team.ts, \"x\")\n */\n// require(name)\nexport const a = 1;"})
        self.assertTrue(unaffected(["lib/b.ts"], quiet))

    def test_the_literal_require_from_createrequire_is_still_followed(self):
        for code in ("import { createRequire } from 'node:module';\nconst require = createRequire(import.meta.url);\nrequire('../lib/b');",
                     "const require = module.createRequire(import.meta.url);",
                     "const root = resolve('.'), require = createRequire(join(root, 'package.json'));",
                     "const { transpileModule } = createRequire(import.meta.url)('typescript');"):
            with self.subTest(code=code):
                self.assertFalse(ui.computed("\n".join(ui.code_lines(code))))

    def test_empty_change_or_no_tree_never_skips(self):
        self.assertFalse(unaffected([]))
        self.assertFalse(suites_unaffected(["lib/b.ts"], []))


class Diff(unittest.TestCase):
    def test_reads_added_modified_deleted_and_executable_files(self):
        raw = change("lib/b.ts") + change("tests/new.test.ts", "A") + change("docs/old.json", "D")
        raw += change("scripts/run.sh", before="100755", after="100755")
        self.assertEqual(changed_paths(raw), ["lib/b.ts", "tests/new.test.ts", "docs/old.json", "scripts/run.sh"])

    def test_renames_type_changes_links_submodules_and_garbage_are_uncertain(self):
        for raw in (b"", b"x", change("lib/b.ts")[:-1], change("lib/b.ts", "R100"),
                    change("lib/b.ts", "T"), change("lib/b.ts", before="120000"),
                    change("lib/b.ts", after="160000"), change("../b.ts"), change("/b.ts"),
                    change("lib/b.ts") + b"\xff\0"):
            with self.subTest(raw=raw):
                with self.assertRaises((Uncertain, UnicodeError, ValueError)):
                    changed_paths(raw)


class Events(unittest.TestCase):
    def test_only_a_pull_request_with_the_ui_suite_can_skip(self):
        diff = lambda *_: change("lib/b.ts")  # noqa: E731
        self.assertFalse(requires_suite("ui", "pull_request", A, B, diff, lambda _: True))
        for event in ("merge_group", "push", "schedule", "workflow_dispatch", "pull_request_target", ""):
            with self.subTest(event=event):
                self.assertTrue(requires_suite("ui", event, A, B, diff, lambda _: True))
        for suite in ("", "UI", "browser", " ui"):
            with self.subTest(suite=suite):
                self.assertTrue(requires_suite(suite, "pull_request", A, B, diff, lambda _: True))

    def test_anything_but_a_proven_true_runs_in_full(self):
        diff = lambda *_: change("lib/b.ts")  # noqa: E731

        def raises(_):
            raise Uncertain("x")
        for answer in (False, None, 1, "true", raises):
            with self.subTest(answer=answer):
                check = answer if callable(answer) else (lambda _, value=answer: value)
                self.assertTrue(requires_suite("ui", "pull_request", A, B, diff, check))

    def test_documentation_only_still_skips_everywhere_it_did(self):
        diff = lambda *_: change("docs/a.md")  # noqa: E731
        self.assertFalse(requires_suite("", "pull_request", A, B, diff, lambda _: False))
        self.assertTrue(requires_suite("ui", "merge_group", A, B, diff, lambda _: True))


class FromGit(WithSyntheticSuite):
    def test_reads_each_revision_through_git(self):
        with tempfile.TemporaryDirectory() as folder:
            def git(*args):
                return subprocess.run(["git", "-C", folder, *args], check=True, capture_output=True)
            git("init", "-q")
            for path, text in BASE.items():
                os.makedirs(os.path.dirname(os.path.join(folder, path)) or folder, exist_ok=True)
                with open(os.path.join(folder, path), "w", encoding="utf-8") as handle:
                    handle.write(text)
            git("add", "-A")
            git("-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-qm", "base")
            here = os.getcwd()
            os.chdir(folder)
            try:
                self.assertTrue(unaffected_between(["lib/b.ts"], ["HEAD"]))
                self.assertFalse(unaffected_between(["lib/a.ts"], ["HEAD"]))
                tree = GitTree("HEAD")
                try:
                    with self.assertRaises(Uncertain):
                        tree.read("lib/not-there.ts")
                finally:
                    tree.close()
                with self.assertRaises(subprocess.CalledProcessError):
                    unaffected_between(["lib/b.ts"], ["c" * 40])
            finally:
                os.chdir(here)


if __name__ == "__main__":
    unittest.main()
