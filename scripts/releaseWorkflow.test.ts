import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { collectReleaseBridgeIssues, collectReleaseWorkflowIssues } from './releaseWorkflow.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const receiverName = '.github/workflows/flight-release.yml';
const releaseFile = '.github/workflows/release.yml';

// The receiver as the contract describes it: Flight's dispatch, the same two facts for recovery, the static
// sweep and the isolated package tests before the version is stamped, the packed-consumer proofs after it,
// and the publish last. The real workflow is checked as soon as it exists; this is the specification its
// author writes against, and every invariant below is a mutation of it.
const receiver = `name: Flight release
on:
  repository_dispatch:
    types: [flight-release]
  workflow_dispatch:
    inputs:
      flight_version:
        description: Flight version that was published
        required: true
        type: string
      flight_commit:
        description: Flight commit that version was published from
        required: true
        type: string
      dry_run:
        default: true
        description: Rehearse the whole pipeline without publishing
        type: boolean
permissions:
  contents: read
concurrency:
  group: release
  cancel-in-progress: false
jobs:
  release:
    name: Stamp and publish the compiler
    runs-on: ubuntu-latest
    permissions:
      contents: read
      id-token: write
    env:
      FLIGHT_VERSION: \${{ github.event.client_payload.version || inputs.flight_version }}
      FLIGHT_COMMIT: \${{ github.event.client_payload.commit || inputs.flight_commit }}
      DRY_RUN: \${{ github.event_name == 'workflow_dispatch' && inputs.dry_run || 'false' }}
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          registry-url: https://registry.npmjs.org
      - run: npm ci --ignore-scripts
      - run: npm run check
      - run: npm run test:packages
      - run: npm run version:tool-compiler -- "$FLIGHT_VERSION"
      - run: npm run pack:check
      - run: npm run smoke
      - name: Publish
        if: env.DRY_RUN != 'true'
        run: npm run release
        env:
          NODE_AUTH_TOKEN: \${{ secrets.NPM_TOKEN }}
`;

function mutated(replace: string | RegExp, replacement: string): string {
  const contents = receiver.replace(replace, replacement);

  expect(contents).not.toBe(receiver);
  return contents;
}

describe('collectReleaseBridgeIssues', () => {
  it('accepts the receiver the contract describes', () => {
    expect(collectReleaseBridgeIssues(receiverName, receiver)).toEqual([]);
  });

  it('reports a workflow it cannot read as a finding rather than a stack', () => {
    expect(collectReleaseBridgeIssues(receiverName, 'on: [unclosed')).toEqual([
      `${receiverName}: the workflow is not readable YAML`,
    ]);
  });

  // Each case breaks one invariant in the shape above. The mutation is the proof: a check that cannot name
  // the invariant it lost would pass on all of these.
  it.each([
    [
      'an event type the sender no longer dispatches',
      'types: [flight-release]',
      'types: [flight_release]',
      'repository_dispatch types must be exactly [flight-release]',
    ],
    [
      'a recovery input that is no longer required',
      '        required: true\n        type: string\n      flight_commit',
      '        required: false\n        type: string\n      flight_commit',
      'manual input flight_version must be required',
    ],
    [
      'a manual dispatch that no longer rehearses',
      '        default: true',
      '        default: false',
      'a manual dispatch must rehearse unless it is armed',
    ],
    [
      'a rehearsal input that is not a boolean',
      '        type: boolean',
      '        type: string',
      'a manual dispatch must rehearse unless it is armed',
    ],
    [
      'a registry that is not the public one',
      'registry-url: https://registry.npmjs.org',
      'registry-url: https://npm.pkg.github.com',
      'no step points setup-node at https://registry.npmjs.org',
    ],
    [
      'a per-ref concurrency group',
      'group: release',
      'group: release-per-ref',
      'concurrency group is release-per-ref rather than release',
    ],
    [
      'a cancellable release',
      'cancel-in-progress: false',
      'cancel-in-progress: true',
      'a running release must not be cancelled by the next one',
    ],
    [
      'writable contents at the top level',
      'permissions:\n  contents: read',
      'permissions:\n  contents: write',
      'top-level contents permission must be read',
    ],
    [
      'a job that cannot attest provenance',
      '      id-token: write\n',
      '',
      'publishing needs id-token write for provenance',
    ],
    [
      'a version that is never stamped',
      '      - run: npm run version:tool-compiler -- "$FLIGHT_VERSION"\n',
      '',
      'nothing stamps the compiler version with `npm run version:tool-compiler`',
    ],
    [
      'a static sweep that runs after the stamp',
      '      - run: npm run check\n      - run: npm run test:packages\n      - run: npm run version:tool-compiler -- "$FLIGHT_VERSION"\n',
      '      - run: npm run test:packages\n      - run: npm run version:tool-compiler -- "$FLIGHT_VERSION"\n      - run: npm run check\n',
      '`npm run check` runs after the version is stamped',
    ],
    [
      'a packed-consumer proof that runs before the stamp',
      '      - run: npm run version:tool-compiler -- "$FLIGHT_VERSION"\n      - run: npm run pack:check\n',
      '      - run: npm run pack:check\n      - run: npm run version:tool-compiler -- "$FLIGHT_VERSION"\n',
      '`npm run pack:check` runs before the version is stamped',
    ],
    [
      'a stamp that carries a version literal',
      '      - run: npm run version:tool-compiler -- "$FLIGHT_VERSION"\n',
      '      - run: npm run version:tool-compiler -- "1.2.3"\n',
      'the stamp carries a version literal',
    ],
    [
      'a stamp that reads no version at all',
      '      - run: npm run version:tool-compiler -- "$FLIGHT_VERSION"\n',
      '      - run: npm run version:tool-compiler\n',
      'the stamp does not read its version from the environment',
    ],
    [
      'the cold-tree sweep a release pipeline must not enter',
      '      - run: npm run check\n',
      '      - run: npm run check\n      - run: npm run ci\n',
      'the release pipeline runs `npm run ci`',
    ],
    [
      'a publish that cannot be rehearsed',
      "        if: env.DRY_RUN != 'true'\n",
      '',
      'nothing rehearses: the publisher is neither invoked with --dry-run nor conditional',
    ],
  ])('reports %s', (_description, replace, replacement, expected) => {
    expect(collectReleaseBridgeIssues(receiverName, mutated(replace, replacement))).toContain(
      `${receiverName}: ${expected}`,
    );
  });

  // The other rehearsal route: a publisher invoked in a rehearsal mode rather than a step conditioned on the
  // input. Either proves a rehearsal needs no token, so the check accepts both.
  it('accepts a publisher that rehearses through its own flag', () => {
    const contents = mutated(
      "        if: env.DRY_RUN != 'true'\n        run: npm run release\n",
      '        run: npm run release -- --dry-run --tag latest\n',
    );

    expect(collectReleaseBridgeIssues(receiverName, contents)).toEqual([]);
  });

  it('reports a payload interpolated into a shell body', () => {
    const contents = mutated(
      '      - run: npm run check\n',
      '      - run: npm run check\n      - run: echo ${{ github.event.client_payload.version }}\n',
    );

    expect(collectReleaseBridgeIssues(receiverName, contents)).toContain(
      `${receiverName}: step 5 interpolates an expression into a shell body`,
    );
  });

  it('reports a step that carries the registry token without publishing', () => {
    const contents = mutated(
      '      - run: npm run smoke\n',
      '      - run: npm run smoke\n        env:\n          NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}\n',
    );

    expect(
      collectReleaseBridgeIssues(receiverName, contents).some((issue) =>
        issue.includes('carries the registry token without publishing'),
      ),
    ).toBe(true);
  });

  it('reports a step that reads or publishes through another registry', () => {
    const contents = mutated('npm run smoke', 'npm run smoke --registry=https://example.invalid');

    expect(collectReleaseBridgeIssues(receiverName, contents)).toContain(
      `${receiverName}: a step reads or publishes through https://example.invalid`,
    );
  });

  it('reports a workflow with no manual recovery inputs', () => {
    const contents = mutated(/ {2}workflow_dispatch:[\s\S]*?\npermissions:/u, '\npermissions:');

    expect(collectReleaseBridgeIssues(receiverName, contents)).toContain(
      `${receiverName}: no manual dispatch inputs, so a lost delivery cannot be replayed`,
    );
  });
});

describe('collectReleaseWorkflowIssues', () => {
  // The manual release publishes the same package as the receiver, so a per-ref group would let the two run
  // at once. This is the concrete overlap between them, and the reason both name the same group.
  it('accepts the manual release this repository ships', () => {
    const contents = readFileSync(path.join(root, releaseFile), 'utf8');

    expect(collectReleaseWorkflowIssues(releaseFile, contents)).toEqual([]);
  });

  it('reports a manual release that could publish concurrently with the receiver', () => {
    const contents = readFileSync(path.join(root, releaseFile), 'utf8');
    const clash = contents.replace('group: release-global', 'group: release-${{ github.ref }}');

    expect(clash).not.toBe(contents);
    expect(collectReleaseWorkflowIssues(releaseFile, clash)).toContain(
      `${releaseFile}: concurrency group is release-\${{ github.ref }} rather than release`,
    );
  });
});
