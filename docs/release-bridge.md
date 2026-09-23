# Release bridge

A compiler release follows an SDK release. Flight publishes its npm graph, dispatches one event into this repository, and the receiving workflow verifies, stamps, and publishes `@flighthq/tool-compiler` at the Flight version. Everything below is that contract: what each side owns, what order it happens in, how a lost delivery is recovered, and what still has to change in Flight.

The receiver is [`.github/workflows/flight-release.yml`](../.github/workflows/flight-release.yml), and every invariant below is checked structurally against that file by [the release workflow gate](../scripts/releaseWorkflow.ts). The sending half does not exist in Flight yet; the section on it is the exact change required.

## Authority

Two decisions, two owners.

**The Flight version is authoritative.** The compiler is stamped to the version Flight just published, because a compiler release exists to describe an SDK release: `@flighthq/tool-compiler` at `x.y.z` is the compiler that was built for Flight `x.y.z`, and nothing else. The checkout's own `0.0.0` development version is a placeholder and is never what reaches the registry.

**Flight decides when.** The dispatch is a statement that the SDK graph it names is published. The bridge does not poll, does not infer, and does not release on its own schedule.

A dispatched run publishes, because that is what the dispatch means. A manual run takes the same path with the same facts, and the receiver decides between rehearsing and publishing **by whether the registry token is available to it**: with no `NPM_TOKEN` it invokes the publisher in its rehearsal mode and publishes nothing, and with the token it publishes. So the token is the arming, and a recovery run that must not publish is run before the secret is in place — or rehearsed from a fork where it cannot be.

## Ordering

1. Flight publishes its npm graph.
2. Flight dispatches `flight-release` with `{version, commit}`.
3. The bridge validates the dispatched version (`npm run version:tool-compiler -- --check "$FLIGHT_VERSION"`) and waits until that version is visible on the public npm registry.
4. The static sweep (`npm run check`) and the isolated package tests (`npm run test:packages`) run.
5. The compiler version is stamped to the dispatched Flight version (`npm run version:tool-compiler`, which validates the version as strict SemVer and rewrites the manifest's own version token exactly).
6. The packed-consumer proofs (`npm run pack:check` and `npm run smoke`) run against the stamped tree.
7. The root release publisher (`npm run release -- --tag latest`) publishes the stamped artifact, with provenance.

The stamp is checkable on its own: the same command with `--check` validates that the manifest already carries the dispatched version, which is how a rehearsal can prove the stamp would be a no-op or a real change without writing anything.

The version stamp is the hinge. Everything before it judges the source; everything after it judges the artifact that would actually reach the registry, packed and installed as a consumer would. A gate that ran after the stamp could only ever approve what it was already too late to change, and a proof that ran before it would be proving a different artifact.

The cold-tree sweep (`npm run ci`) is deliberately **not** in this pipeline. It is the lane that enters the downstream and corpus runs and the committed emission pins, which is a set of concerns a source release does not own and must not be blocked by. The receiver's job is to publish what the static sweep and the package tests already passed.

## Idempotency

A release is identified by the version it publishes, so a redelivered event is harmless: the root release publisher (`npm run release`) reads the published versions from the registry, finds the version it would release already there, and stops successfully having published nothing. The same rule recovers a run that failed partway — rerun it, and the work that already happened is recognized rather than repeated.

npm's own refusal to republish a version is the second line of the same defence. Neither is load-bearing alone: the registry read is what makes the common case a clean no-op, and npm's refusal is what makes a race between two runs a failure rather than a silent second publication.

## Recovery

A dispatch can be lost (a token that expired, a Flight workflow that failed after publishing, an outage). The receiver takes the same two facts manually:

```sh
gh workflow run flight-release.yml \
  --repo flighthq/flight-compiler \
  --field version=<version> \
  --field commit=<commit>
```

The version is a required input, because it drives the stamp: a recovery run that omitted it would release nothing or release the wrong thing. The commit is informational — it reaches the run summary as the Flight revision the release is being made against, and the artifact is identical whether it is supplied or not — so it is optional, and a recovery run can proceed from the version alone. Recovery is the same pipeline as a dispatched run, only with the facts typed instead of delivered, so there is no second release path to keep correct.

## Dry-run rehearsal

A rehearsal is the whole pipeline with the publisher invoked in its rehearsal mode (`npm run release -- --dry-run --tag latest`), which reads the registry, reports what it would publish, and publishes nothing. It needs **no registry token at all** — that is not a convenience but the mechanism: the token's absence is what selects the rehearsal. So the rehearsal is also the way to exercise the bridge before the token exists, and the way to answer "what would this release do" without arming anything.

## Provenance

Publishing is a contract of the root release publisher: it enables npm's provenance attestation, and `id-token: write` is what lets the registry sign it against the workflow run and commit that produced the artifact. The publishing job holds `contents: read` and `id-token: write` and nothing else, and the publisher is the only step that reaches the registry: a raw `npm publish` beside it would publish without the idempotency read, the ordering, or the attestation.

The workflow supplies `NPM_CONFIG_PROVENANCE` from the repository variable `NPM_PROVENANCE`, which is on unless that variable is exactly `false`, and it reaches npm because the publisher passes its environment through to the publish it runs. Provenance needs a public repository. If visibility ever prevents it, `NPM_PROVENANCE=false` is the documented exception — and the release then carries no attestation, which is a real loss and belongs in the release notes rather than in a quiet variable.

## Secrets

| secret | repository | who uses it | what it needs |
| --- | --- | --- | --- |
| `NPM_TOKEN` | `flighthq/flight-compiler` | the publish step only | an npm automation token that may publish `@flighthq/tool-compiler` |
| `FLIGHT_COMPILER_DISPATCH_TOKEN` | `flighthq/flight` | the Flight publish workflow | a GitHub App installation token, or fine-grained PAT, with only the permission a `repository_dispatch` into `flighthq/flight-compiler` requires |
| `NPM_PROVENANCE` (optional) | `flighthq/flight-compiler` | the publish step | `false` only when repository visibility prevents provenance |

A GitHub App installation token is preferred to a PAT: it is scoped to the receiver repository, expires, and its permission is visible in the organisation's settings rather than in one person's account. Grant it nothing else — the token exists to dispatch one event type.

The default `GITHUB_TOKEN` **cannot** be used for this. It is scoped to the repository whose workflow uses it, so a dispatch into another repository is refused; the failure reads as a 403 on the dispatch call and looks like a permissions bug in the receiver rather than the cross-repository limit it is.

## The sending-side change Flight still needs

In the Flight release workflow, immediately after the step that publishes the npm graph — never before it:

```yaml
- name: Dispatch the compiler release bridge
  env:
    FLIGHT_COMPILER_DISPATCH_TOKEN: ${{ secrets.FLIGHT_COMPILER_DISPATCH_TOKEN }}
    FLIGHT_COMMIT: ${{ github.sha }}
    FLIGHT_VERSION: ${{ steps.publish.outputs.version }}
  run: |
    jq -n --arg version "$FLIGHT_VERSION" --arg commit "$FLIGHT_COMMIT" \
      '{event_type: "flight-release", client_payload: {version: $version, commit: $commit}}' |
      curl --fail-with-body --request POST \
        --header "Accept: application/vnd.github+json" \
        --header "Authorization: Bearer $FLIGHT_COMPILER_DISPATCH_TOKEN" \
        --data-binary @- \
        https://api.github.com/repos/flighthq/flight-compiler/dispatches
```

Four things about that step are the contract, not style:

- **`event_type` is `flight-release`.** The receiver triggers on exactly that string; anything else is a run that never happens, with no error anywhere.
- **The payload is `{version, commit}`**, both as strings: the version Flight published, and the Flight commit it published from. The receiver validates both and stamps the version onto the release.
- **The facts go through the environment** and reach `curl` as JSON built by `jq`. Interpolating `${{ github.sha }}` into a shell body — or hand-building the JSON with a heredoc — is the injection surface this repository refuses inside its own workflows, and it is no safer when the string comes from Flight.
- **`--fail-with-body`.** A dispatch that failed must fail the Flight release job. A silent 403 is how a release ends up published upstream and never bridged.

## Concurrency

The receiver and the manual [Release workflow](../.github/workflows/release.yml) both publish the same package, so they share one repository-wide concurrency group, `release`, and neither cancels the other. A concurrency group name is repository-wide, which is exactly why two publishing workflows can share one: a tag push and a dispatched release queue behind each other instead of racing. A running release is never cancelled: a publish that has begun is not safely resumable from the middle, and a cancelled gate is not a passed gate.

`npm run workflows:check` reads both workflows structurally and fails when either group moves. It also pins the invariant list above — the event type, the required recovery inputs, the registry, the permissions, the stamp-between-the-gates order, the tokenless rehearsal, and the ban on interpolating a payload into a shell body — because each of them fails silently rather than loudly when it is lost.
