"""Which changed files can reach the browser-only suites; every uncertainty counts as reaching them.

The accessibility-* browser matrices and the real screen reader pilot build the whole
Next.js application and drive it in a browser. On a pull request their real jobs may
be skipped only when no changed file can reach that build or those test scripts. This
module answers that question conservatively:

- every path under ALWAYS (the application, its styles and public files, the suites,
  their tooling, the CI scripts and the workflows) reaches the suites, and so does
  every path outside MAY_SKIP (root configuration, package*.json, cli/, infra/, …);
- a non-source file (a font, an image, a data file) under MAY_SKIP reaches them too,
  because such files are read in ways no import graph follows;
- any other changed file reaches them when the import graph that starts at the
  application, its configuration and the suites reaches it, at the pull request's
  base, at its head or at the merge commit being tested. A file is followed through
  literal imports, re-exports, require(), CSS @import and url(), and through any
  string that names it (fs reads and esbuild entry points name files that way);
- an import that cannot be resolved, an import computed at run time outside ALWAYS, a
  directory listing outside the reviewed one, an unreadable or undecodable file, or a
  failing git command makes the whole answer "reaches", so the suites run.

It never decides alone: scripts/ci_documentation_scope.py asks it only for a
pull_request event whose base and head are full SHAs and whose workflow declared
CI_SUITE=ui. merge_group, push, schedule and workflow_dispatch never skip this way.
Held by scripts/test_ci_ui_scope.py and tests/ci-merge-group.test.ts.

What this does not cover, on purpose: `next build` also type-checks every .ts file in
tsconfig.json, so a type error in an unreachable file would fail these suites' build.
Product checks (verify) runs the same build on every pull request, so that error still
blocks the change; skipping here does not hide it.

Also not covered (Claude 5 on #3037): app/globals.css imports Tailwind without source(),
so `next build` scans every versioned file for class names, outside the import graph. A
class name written only in a file this module finds unreachable (tests/, lib/, docs/)
can change the generated CSS. Only a class name built at run time or read from data is
exposed this way, because a literal in a reachable file already emits its rule; none was
found. The documentation-only skip from before has the same exposure for .md files.
"""
import json
import re
import subprocess
from pathlib import PurePosixPath

# Prefixes that always reach the suites.
ALWAYS = (
    "app/", "components/", "public/", "styles/", "tests/e2e/", "tooling/", ".github/",
    "scripts/ci-build", "scripts/ci_", "scripts/test_ci_",
)
# Files here may bundle (esbuild entryPoints), copy or execute a file they only name.
RUNNERS = ("tests/e2e/", "tooling/", "scripts/", ".github/")
# The only directories whose files may skip, each only when the graph proves it.
MAY_SKIP = ("lib/", "tests/", "docs/", "scripts/")
SOURCE = (".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs")
CODE = SOURCE + (".json",)
TEXT = CODE + (".css",)
RESOLVE = ("", ".ts", ".tsx", ".mts", ".js", ".jsx", ".mjs", ".cjs", ".json", ".css",
           "/index.ts", "/index.tsx", "/index.js", "/index.mjs")
# Reviewed files that list directories, and the directories they list (all in ALWAYS).
LISTERS = {"tests/e2e/skip-content-focus.mjs": ("app/", "components/")}

# Literal specifiers. Comments are read too: a commented import only adds coverage.
LITERAL = re.compile(
    r"""(?:\bfrom\s*|\bimport\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|\brequire\.resolve\s*\(\s*|@import\s+(?:url\(\s*)?)(["'])([^"'\n]+)\1""")
# Imports whose target is computed while running: the graph cannot follow them.
# A dynamic import or require counts as literal only when its argument is the whole quoted
# string: anything after the closing quote but ")" or "," (a join, a method) is computed.
# One rule for every form that loads or resolves a module by name (Codex G on #3037, four
# returns): the call is literal only when its whole first argument is one quoted string
# followed by ")" or ","; anything else (a variable, a join, a method, a template) is computed.
_CALL = r"""(?:\bimport\.meta\.resolve|\brequire\.resolve|\brequire|\bimport)\s*\("""
COMPUTED = re.compile(
    _CALL + r"""(?!\s*(?P<q1>["'])[^"'\n]*(?P=q1)\s*[),])"""
    + r"""|\brequire\.context\b|\bimport\.meta\.glob\b""")
# new URL(x, import.meta.url) resolves a file by name. Searching from the call to the next
# ";" can be fooled by a ";" inside a string (Codex G on #3037), so the test is per file:
# a file that uses import.meta.url and builds any URL from more than one whole literal is
# computed. Only reviewed files may do it (REVIEWED_COMPUTED).
NEW_URL_COMPUTED = re.compile(r"""\bnew\s+URL\s*\((?!\s*(?P<q>["'])[^"'\n]*(?P=q)\s*,)""")


# A loader under another name (Claude 5 on #3037): createRequire's result bound to anything
# but `require`, createRequire or require renamed on import, or require passed on as a
# value. The call through that name cannot be read, so the file is computed.
CREATE_REQUIRE = re.compile(r"""\bcreateRequire\s*\(""")
# `const require = createRequire(…)`, also as a later declarator (`const a = 1, require = …`).
BOUND_TO_REQUIRE = re.compile(r"""(?:\b(?:const|let|var)\s+|,\s*)require\s*=\s*(?:[A-Za-z_$][\w$]*\.)?$""")
# `createRequire(…)("typescript")`: called at once with one whole literal.
CALLED_WITH_LITERAL = re.compile(r"""createRequire\s*\([^()]*(?:\([^()]*\)[^()]*)*\)\s*\(\s*(["'])[^"'\n]*\1\s*\)""")
RENAMED_LOADER = re.compile(
    r"""\b(?:createRequire|require)\s+as\b|\bcreateRequire\s*:"""
    r"""|[=:,(\[?{]\s*require\b(?!\s*(?:[(.\w$]|=(?!=)))""")


def computed(code):
    if COMPUTED.search(code) or RENAMED_LOADER.search(code):
        return True
    if any(not BOUND_TO_REQUIRE.search(code[:m.start()]) and not CALLED_WITH_LITERAL.match(code, m.start())
           for m in CREATE_REQUIRE.finditer(code)):
        return True
    return "import.meta.url" in code and bool(NEW_URL_COMPUTED.search(code))


LISTING = re.compile(r"""\b(?:readdirSync|readdir|opendirSync|opendir|globSync|glob)\s*\(""")
CSS_URL = re.compile(r"""url\(\s*(["']?)(\.{1,2}/[^"')\s]+)\1\s*\)""")
# A string that names a repository file: "lib/x.ts", "../../lib/x.ts", "seed.ts".
NAMED = re.compile(r"""[A-Za-z0-9_@.\[\]/-]*[A-Za-z0-9_\]-]\.(?:tsx?|mts|cts|m?js|cjs|jsx|json|css)\b""")


# Reviewed one by one: each imports a bundle esbuild built from files it names in strings.
# tests/ci-merge-group's twin in scripts/test_ci_ui_scope.py fails when this set and the
# repository disagree, so a new computed import is reviewed and named, never let through.
REVIEWED_COMPUTED = frozenset({
    # Bundles lib/embed-sdk.ts (named in its build call) and requires that bundle.
    "tests/e2e/accessibility-buyer-actions.mjs",
    "tests/e2e/agreements.mjs",
    "tests/e2e/mobile-render.mjs",
    # Its new URL calls parse page addresses at run time; import.meta.url only names its folder.
    "tests/e2e/run.mjs",
    "tests/e2e/services.mjs",
    # Passes require into a vm context that runs an esbuild bundle of JSX snippets which
    # import only packages (react-dom/server and the JSX runtime); app/ and components/
    # are read through its reviewed listing (LISTERS), not imported.
    "tests/e2e/skip-content-focus.mjs",
    "tests/e2e/store-copy.mjs",
})


class Uncertain(Exception):
    """The graph cannot prove what reaches the suites; the caller runs them in full."""


def always(path):
    return any(path.startswith(prefix) for prefix in ALWAYS)


def outside_graph(path):
    """A changed path that reaches the suites whatever the graph says."""
    if always(path) or not path.startswith(MAY_SKIP):
        return True
    return not path.endswith(CODE) and not path.endswith(".md")


def runs_named(path):
    """Suites, their tooling and CI scripts may load a file they only name."""
    return path.startswith(RUNNERS)


LIFECYCLE = ("preinstall", "install", "postinstall", "preprepare", "prepare", "postprepare",
             "prepublish", "preshrinkwrap", "shrinkwrap", "postshrinkwrap", "dependencies")


def install_hooks(read):
    """`npm ci` runs these package.json scripts before any suite: a file they name is not followed."""
    try:
        scripts = json.loads(read("package.json")).get("scripts") or {}
    except (OSError, ValueError, UnicodeError, KeyError, AttributeError) as error:
        raise Uncertain("package.json unreadable") from error
    if not isinstance(scripts, dict) or any(name in scripts for name in LIFECYCLE):
        raise Uncertain("package.json runs scripts on install")


def without_comments(text):
    """The text with every comment blanked and every string kept, newlines in place.

    Reads quotes and template literals (with their ${...} code) so a "//" or "/*" inside a
    string is not a comment. A regular-expression literal is not recognized; code_lines()
    therefore also keeps the older line filter's lines, so a misread only adds text."""
    out, i, n = [], 0, len(text)
    stack = []  # open template literals: the brace depth of each ${...} being read
    state = "code"
    while i < n:
        c = text[i]
        pair = text[i:i + 2]
        if state == "code":
            if pair == "//":
                state = "line"
                out.append("  ")
                i += 2
                continue
            if pair == "/*":
                state = "block"
                out.append("  ")
                i += 2
                continue
            if c in "'\"":
                state = c
            elif c == "`":
                state = "`"
            elif c == "{" and stack:
                stack[-1] += 1
            elif c == "}" and stack:
                if stack[-1] == 0:
                    stack.pop()
                    state = "`"
                else:
                    stack[-1] -= 1
            out.append(c)
        elif state == "line":
            if c == "\n":
                state = "code"
                out.append(c)
            else:
                out.append(" ")
        elif state == "block":
            if pair == "*/":
                state = "code"
                out.append("  ")
                i += 2
                continue
            out.append(c if c == "\n" else " ")
        elif state == "`":
            if c == "\\":
                out.append(text[i:i + 2])
                i += 2
                continue
            if pair == "${":
                stack.append(0)
                state = "code"
                out.append(pair)
                i += 2
                continue
            if c == "`":
                state = "code"
            out.append(c)
        else:  # inside '...' or "..."; a newline ends a broken one
            if c == "\\":
                out.append(text[i:i + 2])
                i += 2
                continue
            if c == state or c == "\n":
                state = "code"
            out.append(c)
        i += 1
    return "".join(out)


def code_lines(text):
    """The code without its comments: prose such as "an import (lib/x.ts)" is not code, but
    code after a comment on the same line, or a line starting with "*" outside a comment (a
    generator method), is (Claude 5 on #3037). The older filter's lines, which drop whole
    lines starting with "*", "//" or "/*", are added too, so a misread string only adds."""
    stripped = [line for line in without_comments(text).splitlines() if line.strip()]
    older = [line for line in text.splitlines() if not line.lstrip().startswith(("*", "//", "/*"))]
    return stripped + older


def roots(files):
    """Entry points: the application, root configuration, the suites and their tooling."""
    return {f for f in files if f.endswith(TEXT) and (always(f) or "/" not in f)}


def jsx_runtime(files, read):
    """tsconfig's jsxImportSource is imported by every .tsx file without being written."""
    try:
        config = json.loads(read("tsconfig.json"))
    except (OSError, ValueError, UnicodeError, KeyError) as error:
        raise Uncertain("tsconfig.json unreadable") from error
    source = (config.get("compilerOptions") or {}).get("jsxImportSource")
    if source is None or source == "react":
        return set()
    if not isinstance(source, str) or not source.startswith("@/"):
        raise Uncertain("unknown jsxImportSource")
    folder = source[2:].rstrip("/") + "/"
    found = {f for f in files if f.startswith(folder) and f.endswith(TEXT)}
    if not found:
        raise Uncertain("jsxImportSource not found")
    return found


def normalize(base):
    parts = []
    for part in PurePosixPath(base).parts:
        if part == "..":
            if not parts:
                raise Uncertain("path leaves the repository: " + base)
            parts.pop()
        elif part not in (".", ""):
            parts.append(part)
    return "/".join(parts)


def resolve(importer, spec, files):
    """The repository file a specifier names, None for a package; Uncertain otherwise."""
    spec = re.sub(r"\\(.)", r"\1", spec)  # "\.\/x\.mjs" in a string or a pattern is "./x.mjs"
    if spec.startswith(("node:", "data:", "http:", "https:")):
        return None
    if spec.startswith("@/"):
        target = normalize(spec[2:])
    elif spec.startswith(("./", "../")) or spec in (".", ".."):
        target = normalize(str(PurePosixPath(importer).parent / spec))
    elif spec.startswith(("/", "~", "#")) or "\\" in spec:
        raise Uncertain("unresolvable specifier " + spec + " in " + importer)
    else:
        return None  # a package: package.json and package-lock.json always run the suites
    target = target.split("?", 1)[0]
    for suffix in RESOLVE:
        if target + suffix in files:
            return target + suffix
    # A .js specifier for a .ts file (TypeScript's own convention).
    stem, dot, ext = target.rpartition(".")
    if dot and ext in ("js", "mjs", "jsx"):
        for suffix in (".ts", ".tsx", ".mts"):
            if stem + suffix in files:
                return stem + suffix
    raise Uncertain("unresolved import " + spec + " in " + importer)


def named_files(importer, text, files, by_name):
    """Repository files a file names in a string: a path from its folder or from the root,
    or a bare file name, which stands for every file of that name."""
    found = set()
    for token in set(NAMED.findall(text)):
        for candidate in (str(PurePosixPath(importer).parent / token), token):
            try:
                path = normalize(candidate)
            except Uncertain:
                continue
            if path in files:
                found.add(path)
        if "/" not in token:
            found |= by_name.get(token, set())  # join(here, "seed.ts"): every file of that name
    return found


def reachable(files, read):
    """Every repository file of one tree that the suites can load."""
    files = set(files)
    by_name = {}
    for f in files:
        by_name.setdefault(f.rsplit("/", 1)[-1], set()).add(f)
    install_hooks(read)
    seen, named = set(), set()
    queue = sorted(roots(files) | jsx_runtime(files, read))
    while queue:
        current = queue.pop()
        if current in seen:
            continue
        seen.add(current)
        if not current.endswith(TEXT):
            continue
        try:
            text = read(current)
        except (OSError, UnicodeError, KeyError) as error:
            raise Uncertain("unreadable " + current) from error
        code = "\n".join(code_lines(text))
        if computed(code) and current not in REVIEWED_COMPUTED:
            # Only the named end-to-end runners below load a bundle built from a file
            # they name in a string, which named_files() follows. Any other computed
            # import, a page or component included (Codex G on #3037), is unknown.
            raise Uncertain("computed import in " + current)
        if LISTING.search(code) and current not in LISTERS:
            raise Uncertain("unreviewed directory listing in " + current)
        specs = [m.group(2) for m in LITERAL.finditer(text)]
        if current.endswith(".css"):
            specs += [m.group(2) for m in CSS_URL.finditer(text)]
        targets = {resolve(current, spec, files) for spec in specs} - {None}
        mentioned = named_files(current, text, files, by_name)
        if runs_named(current):
            targets |= mentioned  # it may bundle, copy or execute what it names
        else:
            named |= mentioned  # read as data at most: reachable, but nothing it imports
        queue.extend(sorted(targets - seen))
    return seen | named


def changed_paths(raw):
    """Paths of a `git diff --raw --no-renames -z` reply; anything unexpected is Uncertain."""
    if not raw or not raw.endswith(b"\0"):
        raise Uncertain("empty or truncated diff")
    fields = raw[:-1].split(b"\0")
    if len(fields) % 2:
        raise Uncertain("malformed diff")
    paths = []
    for index in range(0, len(fields), 2):
        header = fields[index].decode("ascii", errors="strict").split()
        path = fields[index + 1].decode("utf-8", errors="strict")
        modes = ("100644", "100755", "000000")
        if (len(header) != 5 or header[0][1:] not in modes or not header[0].startswith(":")
                or header[1] not in modes or header[4] not in ("A", "M", "D")):
            raise Uncertain("unsupported change for " + path)
        if path.startswith("/") or ".." in path.split("/") or not path:
            raise Uncertain("unsafe path")
        paths.append(path)
    return paths


def suites_unaffected(changed, trees):
    """True only when no changed path reaches the suites in any of the given trees.

    trees: a list of (files, read) pairs, one per revision (base, head, merge commit)."""
    if not changed or not trees:
        return False
    if any(outside_graph(path) for path in changed):
        return False
    for files, read in trees:
        graph = reachable(files, read)
        if any(path in graph for path in changed):
            return False
    return True


class GitTree:
    """One revision's files and contents, read through git, never from the working tree."""

    def __init__(self, revision, git_dir="."):
        self.revision = revision
        listing = subprocess.check_output(
            ["git", "-C", git_dir, "ls-tree", "-r", "-z", "--full-tree", "--name-only", revision, "--"],
            timeout=60)
        if not listing.endswith(b"\0"):
            raise Uncertain("empty tree")
        self.files = [p.decode("utf-8", errors="strict") for p in listing[:-1].split(b"\0")]
        self.batch = subprocess.Popen(["git", "-C", git_dir, "cat-file", "--batch"],
                                      stdin=subprocess.PIPE, stdout=subprocess.PIPE)

    def read(self, path):
        if "\n" in path:
            raise Uncertain("path with a newline")
        self.batch.stdin.write((self.revision + ":" + path + "\n").encode("utf-8"))
        self.batch.stdin.flush()
        header = self.batch.stdout.readline().decode("ascii", errors="strict").split()
        if len(header) != 3 or header[1] != "blob" or not header[2].isdigit():
            raise Uncertain("not a blob: " + path)
        size = int(header[2])
        if size > 5_000_000:
            raise Uncertain("oversized " + path)
        data = self.batch.stdout.read(size)
        if len(data) != size or self.batch.stdout.read(1) != b"\n":
            raise Uncertain("truncated " + path)
        return data.decode("utf-8", errors="strict")

    def close(self):
        self.batch.stdin.close()
        self.batch.stdout.close()
        self.batch.wait(timeout=30)


def unaffected_between(changed, revisions):
    """The CI entry point: build every revision's graph from git and decide."""
    opened = []
    try:
        for revision in revisions:
            opened.append(GitTree(revision))
        return suites_unaffected(changed, [(tree.files, tree.read) for tree in opened])
    finally:
        for tree in opened:
            try:
                tree.close()
            except (OSError, subprocess.SubprocessError):
                pass


if __name__ == "__main__":  # Local inventory: how many lib/ code files the suites cannot reach.
    tree = GitTree("HEAD")
    graph = reachable(tree.files, tree.read)
    tree.close()
    lib = [f for f in tree.files if f.startswith("lib/") and f.endswith(CODE)]
    tests = [f for f in tree.files if f.startswith("tests/") and not f.startswith("tests/e2e/")]
    print(len([f for f in lib if f not in graph]), "of", len(lib), "lib code files cannot reach the suites")
    print(len([f for f in tests if f not in graph]), "of", len(tests), "tests files outside tests/e2e cannot reach them")
