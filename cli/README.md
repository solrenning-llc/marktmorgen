# marktmorgen

Your Marktmorgen store from the command line. It runs the same tools as the Marktmorgen MCP server, with the same key, limits and rules, so a script, an AI agent that runs commands, and your AI assistant all do the same things.

Needs Node 20 or later. No other dependency.

## Set your key

Make an API key in your studio, under API keys, then:

```bash
export MARKTMORGEN_API_KEY=nl_live_...
```

The key is read only from this variable, never from the command, so it stays out of your shell history.

## Use it

```bash
node marktmorgen.mjs tools
```

```bash
node marktmorgen.mjs get_revenue_by_channel --days 7
```

```bash
node marktmorgen.mjs list_products
```

`tools` lists what your key can do. Any tool prints its answer as JSON. Tools about a stretch of time take `--days 7`, `--days 30` or `--days 90` (30 when left out); `list_products` takes `--cursor` with the `next` value of the page before.

Exit codes: 0 done, 1 the tool answered with an error, 2 the command or the key was refused, or Marktmorgen could not be reached.

## State

Built and tested against the real MCP server with a synthetic store (`tests/cli.test.ts`). Every tool today reads only. It is not published to npm: publishing needs the owner's own npm account (631 [AA1] (f)), so for now it runs from this folder.
