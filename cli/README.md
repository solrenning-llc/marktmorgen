# marktmorgen

Your Marktmorgen store from the command line. It runs the same tools as the Marktmorgen MCP server, with the same key, limits and rules, so a script, an AI agent that runs commands, and your AI assistant all do the same things.

Needs Node 20 or later. No other dependency.

## Set your key

Make an API key in your studio, under API keys, then in Bash:

```bash
read -r -s -p "Marktmorgen API key: " MARKTMORGEN_API_KEY
printf '\n'
export MARKTMORGEN_API_KEY
```

Type your key at the prompt, not as part of a command saved in shell history. The prompt does not echo it. The CLI reads the key from this variable. Do not paste it into a command or an option. A secret manager can also supply the variable.

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

`tools` lists what your key can do. Text results are printed as text. Other content is printed as JSON. Tools about a stretch of time take `--days 7`, `--days 30` or `--days 90` (30 when left out); `list_products` takes `--cursor` with the `next` value of the page before.

Exit codes: 0 done, 1 the tool answered with an error, 2 the command or the key was refused, or Marktmorgen could not be reached.

## State

Built and tested against the real MCP server with a synthetic store (`tests/cli.test.ts`). Every tool today reads only. It is not published to npm: publishing needs the owner's own npm account (631 [AA1] (f)), so for now it runs from this folder.
