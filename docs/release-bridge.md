# Release bridge

A compiler release follows an SDK release. Flight publishes its npm graph, dispatches one event into this repository, and [`.github/workflows/release-bridge.yml`](../.github/workflows/release-bridge.yml) verifies, gates, and publishes `@flighthq/tool-compiler`. Everything below is that contract: what each side owns, what order it happens in, how a lost delivery is recovered, and what still has to change in Flight.

The receiving half exists and is pinned by [a repository gate](../scripts/releaseWorkflow.ts). The sending half does not exist in Flight yet; the section on it is the exact change required.

## Authority

Two decisions, two owners.

The **version is decided here**. Publishing is `packages/tool-compiler/package.json`'s version, exactly as a reviewed change in this repository left it. The bridge derives no version from the Flight version and stamps nothing: a compiler that computed its own version from an upstream release would put the release model in a workflow, where it cannot be reviewed, and would publish a compiler release for every SDK change even when nothing here moved. Bumping the manifest is an ordinary reviewed change.

**Flight decides when.** The dispatch is a statement that the SDK graph it names is published. The bridge does not poll, does not infer, and does not release on its own schedule.

A dispatched run publishes, because that is what the dispatch means; a **manual** run rehearses unless it is armed (`dry_run` defaults to true). The asymmetry is deliberate: automation should act, and a human recovering a delivery at midnight should have to say so.

## Ordering

1. Flight publishes its npm graph.
2. Flight dispatches `flight-release` with `{version, commit}`.
3. The bridge checks the two facts are well formed (a release version, a full revision).
4. The bridge runs the whole gate from a cold tree (`npm run ci`).
5. The bridge proves the artifact a consumer would install (`npm run smoke`).
6. The bridge reads the public registry to see whether this compiler version is already published.
7. The bridge publishes with provenance.

Steps 4 and 5 are non-negotiable predecessors of step 7 and the workflow orders them that way. Nothing here may reach the registry before the SDK it describes, and nothing may reach it before the gate: a release is the one run where skipping the sweep cannot be corrected later.

## Idempotency

A release is identified by the version it publishes, and that makes a redelivered event harmless. A second dispatch for the same Flight version finds the compiler version already on the public registry and stops successfully, having published nothing. The same rule recovers a run that failed partway: rerun it, and the work that already happened is recognized rather than repeated.

npm's own refusal to republish a version is the second line of the same defence. Neither is load-bearing alone: the registry read is what makes the common case a clean no-op, and npm's refusal is what makes a race between two runs a failure rather than a silent second publication.

## Recovery

A dispatch can be lost (a token that expired, a Flight workflow that failed after publishing, an outage). The bridge takes the same two facts manually:

```sh
gh workflow run release-bridge.yml \
  --repo flighthq/flight-compiler \
  --field flight_version=<version> \
  --field flight_commit=<commit> \
  --field dry_run=false
```

Both facts are required inputs, so a recovery run cannot be started with half the record. Recovery is the same pipeline as a dispatched run — the only difference is who supplied the facts — so there is no second release path to keep correct. Rehearse first (`dry_run` left at its default) when the cause of the lost delivery is unknown; a rehearsal reads the registry, runs every gate, and publishes nothing.

## Dry-run rehearsal

A rehearsal is the whole pipeline with the publish step skipped. It needs **no registry token at all**: the `NPM_TOKEN` secret appears only in the publishing step's environment, and that step cannot run in a rehearsal. So the rehearsal is also the way to exercise the bridge before the token exists, and the way to answer "what would this release do" without arming anything.

## Provenance

`npm publish --provenance` with `id-token: write` has the registry sign an attestation linking the published artifact to the workflow run and commit that produced it. The publishing job holds `contents: read` and `id-token: write` and nothing else.

Provenance needs a public repository. If visibility ever prevents it, `NPM_PROVENANCE=false` is the documented exception — and the release then carries no attestation, which is a real loss and belongs in the release notes rather than in a quiet environment variable.

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
- **The payload is `{version, commit}`**, both as strings: the version Flight published, and the Flight commit it published from. The receiver validates both and records them as provenance for the release.
- **The facts go through the environment** and reach `curl` as JSON built by `jq`. Interpolating `${{ github.sha }}` into a shell body — or hand-building the JSON with a heredoc — is the injection surface this repository refuses inside its own workflows, and it is no safer when the string comes from Flight.
- **`--fail-with-body`.** A dispatch that failed must fail the Flight release job. A silent 403 is how a release ends up published upstream and never bridged.

## Concurrency

The bridge and the manual [Release workflow](../.github/workflows/release.yml) both publish the same package, so they share one repository-wide concurrency group, `release-global`, and neither cancels the other. A concurrency group name is repository-wide, which is exactly why two publishing workflows can share one: a tag push and a dispatched release queue behind each other instead of racing. A running release is never cancelled: a publish that has begun is not safely resumable from the middle, and a cancelled gate is not a passed gate.

`npm run workflows:check` reads both workflows structurally and fails when either group moves. It also pins the invariant list above — the event type, the required recovery inputs, the registry, the permissions, the gate-before-publish order, the tokenless rehearsal, and the ban on interpolating a payload into a shell body — because each of them fails silently rather than loudly when it is lost.
