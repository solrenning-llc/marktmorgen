# Form save acknowledgement — evidence only

This isolated proof examines the existing FormsEditor save acknowledgement. It is separate from the form-store sibling repair and does not reopen #2857.

Source under review: components/forms-editor.tsx, frozen blob d38fe5553e45b3e214a7f46ceb5052bd218940a7. The save callback currently accepts truthy data.ok without checking response.ok.

Architecture credit: Codex M, codex/m-checkout-fields-save-proof@948d2c883d4914c9adfdd1058ebccfa436faed9b, proofs/m/checkout-fields-save-ack.mjs (blob277e640cabca25f36939624e9891ddc7dde54aa4). This proof uses the real FormsEditor, React, Next AppRouterContext, server render and Chromium hydration. The router observes refresh calls; only the four local HTTP responses are synthetic. FormsEditor uses a draft div, so the proof observes its actual name input, not a nonexistent HTML form.

## Reproduction

From the repository root:

    TMPDIR=/dev/shm node proofs/k2/form-save-ack.mjs

The four responses are HTTP 200 {ok:true}, HTTP 200 {ok:false}, HTTP 200 {ok:"true"}, and HTTP 503 {ok:true}. Six checks per case require exactly one local POST containing the entered form name, correct editor retention, refresh count, confirmation toast, and no hydration/page error. Only the deliberately injected 503 resource console line is excluded; all other errors remain failures.

Before dispatch, the complete exercise admits at most four local POSTs of 4 KiB each and response bodies of 128 B each. The interceptor enforces both total and per-case counts before fulfillment and refuses every other URL. No Redis, signed-in application, provider, payment or external network is used.

## Result

Executed against the frozen component with Chromium 141.0.7390.37: **24 checks, 18 pass, six fail**. The HTTP 200  boolean-true success and HTTP 200  boolean-false refusal controls pass. HTTP 200  string-true and HTTP 503  boolean-true each close the draft, refresh once, and emit `Form made.` despite the expected refusal: three failures per anomalous response. There were no hydration/page errors in any case.

Exactly four intercepted local POSTs were observed, each checked against the 4096-byte bound before fulfillment; every synthetic JSON response was admitted under 128 bytes before the server/browser started. The forbidden-request counter was zero. The Chromium profile and generated SSR files used an ephemeral TMPDIR=/dev/shm directory and were cleaned in finally.

Actual scoped TypeScript (one proof root with real imports) reports zero diagnostics. ESLint of the proof TypeScript and runner reports zero diagnostics. `node --check` passes. The output log is `/dev/shm/k2-ack-run.log` in this execution; the immutable source, frozen blob, scenarios and exact failing observations are preserved in the three proof files for publication by the parent.

## Limits

This proves only the component's acknowledgement behavior under the selected synthetic responses. It does not prove backend data loss, persistence failure, remote exploitation, production behavior, a complete buyer journey, all browsers, or accessibility conformance. No product, runtime configuration, CI, admission, price, limit or gate is modified.

## Exact observations

```json
{
  "sourceBlob": "d38fe5553e45b3e214a7f46ceb5052bd218940a7",
  "browser": "141.0.7390.37",
  "checks": 24,
  "failures": [
    {
      "name": "string-ok: close only on confirmed success",
      "actual": false,
      "expected": true
    },
    {
      "name": "string-ok: refresh only on confirmed success",
      "actual": 1,
      "expected": 0
    },
    {
      "name": "string-ok: toast only on confirmed success",
      "actual": [
        "Form made."
      ],
      "expected": []
    },
    {
      "name": "failed-http: close only on confirmed success",
      "actual": false,
      "expected": true
    },
    {
      "name": "failed-http: refresh only on confirmed success",
      "actual": 1,
      "expected": 0
    },
    {
      "name": "failed-http: toast only on confirmed success",
      "actual": [
        "Form made."
      ],
      "expected": []
    }
  ],
  "observations": [
    {
      "name": "confirmed",
      "status": 200,
      "observed": {
        "editor": false,
        "refresh": 1,
        "toasts": [
          "Form made."
        ]
      }
    },
    {
      "name": "explicit-refusal",
      "status": 200,
      "observed": {
        "editor": true,
        "refresh": 0,
        "toasts": []
      }
    },
    {
      "name": "string-ok",
      "status": 200,
      "observed": {
        "editor": false,
        "refresh": 1,
        "toasts": [
          "Form made."
        ]
      }
    },
    {
      "name": "failed-http",
      "status": 503,
      "observed": {
        "editor": false,
        "refresh": 1,
        "toasts": [
          "Form made."
        ]
      }
    }
  ],
  "bounds": {
    "localPosts": 4,
    "postBytes": 4096,
    "responseBytes": 128
  },
  "forbiddenRequests": 0
}
```

Quality checks also applied the repository public-data detector directly to all three new files: zero findings. New-file whitespace checks reported no diagnostics; git diff --no-index uses exit1 for the new-file difference itself, so this is not represented as an exit-zero normal tracked diff.

The initial immutable proof commit 61890f32b72823c7422cac28d402e49a57ba430e is preserved. The runner now accepts a selected source checkout and its complete expected component blob as CLI arguments, while retaining the same four cases, 24 functional checks, default waits and request ceilings. A provenance mismatch alone is not a product failure.


## Comparing a corrective checkout

The evidence checkout owns the fixture and runner. The source checkout owns the component, its application imports, framework packages and tsconfig. With no arguments, both checkouts are the evidence checkout and the expected component remains the original d38fe5553e45b3e214a7f46ceb5052bd218940a7.

    TMPDIR=/dev/shm node /path/to/evidence/proofs/k2/form-save-ack.mjs /path/to/source EXPECTED_40_HEX_COMPONENT_BLOB

Argument 2 selects sourceRoot; argument 3 is validated as a complete 40-hex Git blob and checked against the selected components/forms-editor.tsx before browser requests. The fixture import always points to evidenceRoot/tests/k-form-save-ack.proof.ts. The runner resolves @/ imports to sourceRoot and resolves real React, ReactDOM and Next packages from that source checkout, keeping one framework identity through SSR and hydration. No product source is rewritten. The selected evidence/source roots, expected blob and actual blob are included in the output.

One full default baseline execution after this wiring change reproduced **24 checks, 18 pass, six fail**, with the same exact six failing observations, Chromium 141.0.7390.37, four local POSTs under 4096 B, responses under 128 B, and zero forbidden requests. The fixture remains byte-identical (Git blob 9f695eec78376a05437ad67480d6fb8b836f9951). Syntax and directed runner ESLint pass. This execution does not claim a corrective checkout is green or that a distinct sourceRoot has already been executed; that comparison belongs to the future corrective change.

Architecture remains credited to Codex M 948d2c88; the original proof is not replaced. No functional assertion, case, timeout or ceiling changed to enable parameterization.
