"""The JavaScript/TypeScript CodeQL analysis, split into parts that run side by side.

One job evaluating all of security-extended took about 35 minutes of query evaluation on
the 4-CPU runner, most of it waiting behind the data-flow queries. The parts below run the
same suite, on the same database contents, in parallel jobs; each part's SARIF is kept
back (upload: never) and the job `analyze` of .github/workflows/codeql.yml merges them
into one upload with the same category and the same job as before, so code scanning sees
one analysis, exactly as with one job.

How the queries are divided, so that none is ever lost:
- parts 1 to 3 keep only the query ids listed for them (the first filter is an include,
  so a query matching none of its ids is left out of that part);
- the last part runs the whole suite minus every id listed for parts 1 to 3 (the first
  filter is an exclude), so a query CodeQL adds later lands there automatically.
The union is therefore the whole suite and the parts never overlap. `check` proves it on
the real results before anything is uploaded: every listed id of a part was evaluated in
that part and nowhere else, and the last part holds none of them. A listed id that the
suite no longer has fails the check instead of silently shrinking a part.

Usage:
  python3 scripts/codeql_query_parts.py config N   -> prints `config=<JSON>` for init
  python3 scripts/codeql_query_parts.py check DIR  -> checks DIR/javascript-part-N.sarif
"""
import json
import os
import sys

SUITE = "security-extended"
CATEGORY = "/language:javascript-typescript"

# Grouped by the libraries the queries share, so a part computes each library once.
LISTED = (
    # 1. Cross-site scripting, HTML sanitizing, redirects, logging and storage of data.
    (
        "js/xss", "js/reflected-xss", "js/stored-xss", "js/xss-through-dom",
        "js/xss-through-exception", "js/html-constructed-from-input", "js/unsafe-jquery-plugin",
        "js/unsafe-html-expansion", "js/incomplete-html-attribute-sanitization",
        "js/bad-tag-filter", "js/incomplete-multi-character-sanitization",
        "js/incomplete-sanitization", "js/double-escaping",
        "js/client-side-unvalidated-url-redirection", "js/server-side-unvalidated-url-redirection",
        "js/cross-window-information-leak", "js/system-prompt-injection", "js/clear-text-logging",
        "js/clear-text-storage-of-sensitive-data", "js/log-injection", "js/tainted-format-string",
        "js/stack-trace-exposure",
    ),
    # 2. Commands, code, files and cryptography.
    (
        "js/command-line-injection", "js/indirect-command-line-injection",
        "js/second-order-command-line-injection", "js/shell-command-injection-from-environment",
        "js/shell-command-constructed-from-input", "js/unnecessary-use-of-cat", "js/code-injection",
        "js/unsafe-code-construction", "js/bad-code-sanitization", "js/unsafe-dynamic-method-access",
        "js/unvalidated-dynamic-method-call", "js/path-injection", "js/zipslip",
        "js/file-access-to-http", "js/http-to-file-access", "js/insecure-temporary-file",
        "js/file-system-race", "js/hardcoded-data-interpreted-as-code",
        "js/template-object-injection", "js/exposure-of-private-files",
        "js/weak-cryptographic-algorithm", "js/insecure-randomness", "js/insufficient-password-hash",
        "js/insufficient-key-size", "js/biased-cryptographic-random",
    ),
    # 3. Regular expressions, URLs, outgoing requests, queries and XML.
    (
        "js/polynomial-redos", "js/redos", "js/regex-injection", "js/regex/missing-regexp-anchor",
        "js/incomplete-hostname-regexp", "js/overly-large-range", "js/useless-regexp-character-escape",
        "js/identity-replacement", "js/incomplete-url-scheme-check",
        "js/incomplete-url-substring-sanitization", "js/incorrect-suffix-check",
        "js/missing-origin-check", "js/request-forgery", "js/client-side-request-forgery",
        "js/sql-injection", "js/xpath-injection", "js/xxe", "js/xml-bomb", "js/unsafe-deserialization",
        "js/insecure-download", "js/functionality-from-untrusted-domain",
        "js/functionality-from-untrusted-source", "js/insecure-dependency",
    ),
    # 4. Everything else in the suite (cookies, CORS, prototype pollution, resource
    #    exhaustion, sessions, diagnostics, summaries and any query added later).
)
PARTS = len(LISTED) + 1


def listed_ids():
    return [query for part in LISTED for query in part]


def config(part):
    """The init `config` (JSON is YAML) for part 1..PARTS."""
    if not isinstance(part, int) or isinstance(part, bool) or not 1 <= part <= PARTS:
        raise ValueError("part must be 1.." + str(PARTS))
    if part < PARTS:
        query_filter = {"include": {"id": list(LISTED[part - 1])}}
    else:
        query_filter = {"exclude": {"id": listed_ids()}}
    return {"queries": [{"uses": SUITE}], "query-filters": [query_filter]}


def evaluated(sarif):
    """Query ids a CodeQL SARIF log evaluated (its rules, with or without results)."""
    runs = sarif.get("runs") if isinstance(sarif, dict) else None
    if not isinstance(runs, list) or len(runs) != 1 or not isinstance(runs[0], dict):
        raise ValueError("expected exactly one run")
    run = runs[0]
    category = (run.get("automationDetails") or {}).get("id", "")
    if not str(category).startswith(CATEGORY):
        raise ValueError("unexpected category " + repr(category))
    tool = run.get("tool") or {}
    components = [tool.get("driver") or {}] + list(tool.get("extensions") or [])
    ids = set()
    for component in components:
        for rule in component.get("rules") or []:
            ids.add(rule.get("id"))
    return ids


def check(directory):
    """Problems with the parts' SARIF files in directory; empty when all may be uploaded."""
    expected = {"javascript-part-%d.sarif" % n for n in range(1, PARTS + 1)}
    try:
        present = {name for name in os.listdir(directory) if name.endswith(".sarif")}
    except OSError as error:
        return ["cannot read " + directory + ": " + str(error)]
    problems = []
    if present != expected:
        problems.append("SARIF files %s, expected %s" % (sorted(present), sorted(expected)))
        return problems
    found = {}
    for n in range(1, PARTS + 1):
        path = os.path.join(directory, "javascript-part-%d.sarif" % n)
        try:
            with open(path, encoding="utf-8") as handle:
                found[n] = evaluated(json.load(handle))
        except (OSError, ValueError) as error:
            problems.append("part %d: %s" % (n, error))
    if problems:
        return problems
    listed = set(listed_ids())
    for n in range(1, PARTS):
        own = set(LISTED[n - 1])
        missing = own - found[n]
        if missing:
            problems.append("part %d did not evaluate %s" % (n, sorted(missing)))
        stray = (found[n] & listed) - own
        if stray:
            problems.append("part %d evaluated queries of another part: %s" % (n, sorted(stray)))
    if not found[PARTS]:
        problems.append("part %d evaluated nothing" % PARTS)
    stray = found[PARTS] & listed
    if stray:
        problems.append("part %d evaluated listed queries: %s" % (PARTS, sorted(stray)))
    for a in range(1, PARTS + 1):
        for b in range(a + 1, PARTS + 1):
            both = found[a] & found[b] & listed
            if both:
                problems.append("parts %d and %d both evaluated %s" % (a, b, sorted(both)))
    if not problems:
        total = set().union(*found.values())
        print("CodeQL parts: " + ", ".join(
            "part %d %d queries" % (n, len(found[n])) for n in range(1, PARTS + 1)
        ) + "; %d distinct queries in all." % len(total))
    return problems


def main(argv):
    if len(argv) == 3 and argv[1] == "config":
        try:
            part = int(argv[2])
            text = json.dumps(config(part), separators=(",", ":"))
        except ValueError as error:
            print(error, file=sys.stderr)
            return 2
        print("config=" + text)
        return 0
    if len(argv) == 3 and argv[1] == "check":
        problems = check(argv[2])
        for problem in problems:
            print(problem)
        return 1 if problems else 0
    print("usage: codeql_query_parts.py config N | check DIR", file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv))
