"""Ensure the reviewed development-only chain is absent from Next runtime traces."""
import json
import sys
from pathlib import Path

# The development-only chains reviewed for the audit gate, including GHSA-fc5q-39xc-vjpf's picomatch path.
FORBIDDEN = ["braces", "micromatch", "fast-glob", "eslint-config-next", "@next/eslint-plugin-next", "picomatch", "tinyglobby", "fdir"]


def check_traces(root):
    traces = list(Path(root).rglob("*.nft.json"))
    if not traces:
        raise ValueError("No production dependency traces; no approval")
    for trace in traces:
        value = json.loads(trace.read_text())
        files = value.get("files")
        if not isinstance(files, list):
            raise ValueError("Malformed production dependency trace")
        for filename in files:
            normalized = "/" + str(filename).replace("\\", "/").strip("/") + "/"
            for package in FORBIDDEN:
                if "/node_modules/" + package + "/" in normalized:
                    raise ValueError("Reviewed development dependency entered runtime: " + package + " in " + str(trace))
    return len(traces)


if __name__ == "__main__":
    count = check_traces(sys.argv[1] if len(sys.argv) > 1 else ".next")
    print("Production traces checked: " + str(count) + "; reviewed development chain absent")
