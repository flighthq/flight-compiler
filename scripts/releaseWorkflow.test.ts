import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { collectReleaseBridgeIssues, collectReleaseWorkflowIssues } from './releaseWorkflow.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const receiverFile = '.github/workflows/flight-release.yml';
const releaseFile = '.github/workflows/release.yml';

function read(file: string): string {
  return readFileSync(path.join(root, file), 'utf8');
}

function mutated(file: string, replace: string | RegExp, replacement: string): string {
  const contents = read(file);
  const change = contents.replace(replace, replacement);

  // A mutation that changed nothing proves nothing: it would report the same result as the unmutated file and
  // the case would pass for the wrong reason.
  expect(change).not.toBe(contents);
  return change;
}

describe('collectReleaseBridgeIssues', () => {
  // The shipped receiver is the subject, not a fixture: every invariant below is the shipped workflow with one
  // thing broken, so a change to the workflow that moves an anchor fails loudly here rather than quietly
  // weakening the check.
  it('accepts the receiver this repository ships', () => {
    expect(collectReleaseBridgeIssues(receiverFile, read(receiverFile))).toEqual([]);
  });

  it('reports a workflow it cannot read as a finding rather than a stack', () => {
    expect(collectReleaseBridgeIssues(receiverFile, 'on: [unclosed')).toEqual([
      `${receiverFile}: the workflow is not readable YAML`,
    ]);
  });

  it.each([
    [
      'an event type the sender no longer dispatches',
      'types: [flight-release]',
      'types: [flight_release]',
      'repository_dispatch types must be exactly [flight-release]',
    ],
    [
      'a recovery version that may be omitted',
      '      version:\n        description: Flight release version to bridge\n        required: true',
      '      version:\n        description: Flight release version to bridge\n        required: false',
      'manual input version must be required',
    ],
    [
      'a commit no manual input supplies',
      'FLIGHT_COMMIT: ${{ github.event_name ==',
      'FLIGHT_COMMIT_UNUSED: ${{ github.event_name ==',
      'the commit is not read from a declared manual input',
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
      'contents a release may write',
      'permissions:\n  contents: read',
      'permissions:\n  contents: write',
      'the workflow grants contents write',
    ],
    [
      'a permission beyond the two a release needs',
      'permissions:\n  contents: read\n  id-token: write',
      'permissions:\n  contents: read\n  id-token: write\n  packages: write',
      'the workflow grants packages write',
    ],
    [
      'a job that cannot attest provenance',
      '  id-token: write\n',
      '',
      'publishing needs id-token write for provenance',
    ],
    [
      'no wait for the upstream release to be visible',
      '            published_version="$(npm view "@flighthq/sdk@${FLIGHT_VERSION}" version 2>/dev/null || true)"\n',
      '',
      'nothing waits for the upstream release to be visible on the registry',
    ],
    [
      'a static sweep that runs after the stamp',
      '      - name: Check the compiler repository\n        run: npm run check\n      - name: Test packages in isolation\n        run: npm run test:packages\n',
      '',
      'the publishing job never runs `npm run check`',
    ],
    [
      'a version that is only validated, never stamped',
      '        run: npm run version:tool-compiler -- "$FLIGHT_VERSION"\n',
      '        run: npm run version:tool-compiler -- --check "$FLIGHT_VERSION"\n',
      'nothing stamps the compiler version with `npm run version:tool-compiler`',
    ],
    [
      'a packed-consumer proof that runs before the stamp',
      '      - name: Stamp the compiler version\n        run: npm run version:tool-compiler -- "$FLIGHT_VERSION"\n      - name: Check the stamped package artifact\n        run: npm run pack:check\n',
      '      - name: Check the stamped package artifact\n        run: npm run pack:check\n      - name: Stamp the compiler version\n        run: npm run version:tool-compiler -- "$FLIGHT_VERSION"\n',
      '`npm run pack:check` runs before the version is stamped',
    ],
    [
      'the cold-tree sweep a release pipeline must not enter',
      '      - name: Check the compiler repository\n        run: npm run check\n',
      '      - name: Check the compiler repository\n        run: npm run check\n      - name: Cold sweep\n        run: npm run ci\n',
      'the release pipeline runs `npm run ci`',
    ],
    [
      'a publish that bypasses the root release publisher',
      '            npm run release -- --tag latest',
      '            npm publish --access public --tag latest',
      'step 11 publishes with a raw npm publish',
    ],
    [
      'a workflow that publishes no other way',
      '          if [ "$release_intent" = dry-run ]; then\n            npm run release -- --dry-run --tag latest\n          else\n            npm run release -- --tag latest\n          fi\n',
      '          npm publish --access public --tag latest\n',
      'no step publishes through the root release publisher',
    ],
    [
      'a release that cannot rehearse',
      '            npm run release -- --dry-run --tag latest',
      '            npm run release -- --tag latest',
      'nothing rehearses: the publisher is neither invoked with --dry-run nor conditional',
    ],
    [
      'a registry token on a step that does not publish',
      '      - name: Stamp the compiler version\n',
      '      - name: Stamp the compiler version\n        env:\n          NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}\n',
      'step 8 carries the registry token without publishing',
    ],
  ])('reports %s', (_description, replace, replacement, expected) => {
    expect(collectReleaseBridgeIssues(receiverFile, mutated(receiverFile, replace, replacement))).toContain(
      `${receiverFile}: ${expected}`,
    );
  });

  it('reports a payload interpolated into a shell body', () => {
    const contents = mutated(
      receiverFile,
      '      - name: Check the compiler repository\n        run: npm run check\n',
      '      - name: Check the compiler repository\n        run: npm run check\n      - name: Echo the payload\n        run: echo ${{ github.event.client_payload.version }}\n',
    );

    expect(collectReleaseBridgeIssues(receiverFile, contents)).toContain(
      `${receiverFile}: step 7 interpolates an expression into a shell body`,
    );
  });

  it('reports a step that reads or publishes through another registry', () => {
    const contents = mutated(receiverFile, 'npm run smoke', 'npm run smoke --registry=https://example.invalid');

    expect(collectReleaseBridgeIssues(receiverFile, contents)).toContain(
      `${receiverFile}: a step reads or publishes through https://example.invalid`,
    );
  });

  it('reports a workflow with no manual recovery inputs', () => {
    const contents = mutated(receiverFile, / {2}workflow_dispatch:[\s\S]*?\n\npermissions:/u, '\npermissions:');

    expect(collectReleaseBridgeIssues(receiverFile, contents)).toContain(
      `${receiverFile}: no manual dispatch inputs, so a lost delivery cannot be replayed`,
    );
  });
});

describe('collectReleaseWorkflowIssues', () => {
  // The manual release publishes the same package as the receiver, so a different group would let the two run
  // at once. This is the concrete overlap between them, and the reason both name the same group.
  it('accepts the manual release this repository ships', () => {
    expect(collectReleaseWorkflowIssues(releaseFile, read(releaseFile))).toEqual([]);
  });

  it('reports a manual release that could publish concurrently with the receiver', () => {
    const contents = mutated(releaseFile, 'group: release', 'group: release-${{ github.ref }}');

    expect(collectReleaseWorkflowIssues(releaseFile, contents)).toContain(
      `${releaseFile}: concurrency group is release-\${{ github.ref }} rather than release`,
    );
  });
});
