import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { collectReleaseBridgeIssues, collectReleaseWorkflowIssues } from './releaseWorkflow.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bridgeFile = '.github/workflows/release-bridge.yml';
const releaseFile = '.github/workflows/release.yml';

describe('collectReleaseBridgeIssues', () => {
  it('accepts the bridge this repository ships', () => {
    const contents = readFileSync(path.join(root, bridgeFile), 'utf8');

    expect(collectReleaseBridgeIssues(bridgeFile, contents)).toEqual([]);
  });

  it('reports a workflow it cannot read as a finding rather than a stack', () => {
    expect(collectReleaseBridgeIssues(bridgeFile, 'on: [unclosed')).toEqual([
      `${bridgeFile}: the workflow is not readable YAML`,
    ]);
  });

  // Each case is one invariant broken in the shipped shape. The mutation is the proof: a check that cannot
  // name the invariant it lost would pass on all of these.
  it.each([
    [
      'an event type the sender no longer dispatches',
      'types: [flight-release]',
      'types: [flight_release]',
      'repository_dispatch types must be exactly [flight-release]',
    ],
    [
      'a recovery input that is no longer required',
      '        required: true',
      '        required: false',
      'manual input flight_version must be required',
    ],
    [
      'a manual dispatch that no longer rehearses',
      'dry_run:\n        default: true',
      'dry_run:\n        default: false',
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
      'group: release-global',
      'group: release-per-ref',
      'concurrency group is release-per-ref rather than release-global',
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
    ['a gate that no longer runs', '      - run: npm run ci\n', '', 'the publishing job never runs `npm run ci`'],
    [
      'a publish with no rehearsal condition',
      "        if: env.DRY_RUN != 'true' && env.SKIP_PUBLISH != 'true'\n",
      '',
      'publishing is not conditioned on the rehearsal input',
    ],
  ])('reports %s', (_description, replace, replacement, expected) => {
    const contents = readFileSync(path.join(root, bridgeFile), 'utf8');
    const mutated = contents.replace(replace, replacement);

    expect(mutated).not.toBe(contents);
    expect(collectReleaseBridgeIssues(bridgeFile, mutated)).toContain(`${bridgeFile}: ${expected}`);
  });

  it('reports an expression interpolated into a shell body', () => {
    const contents = readFileSync(path.join(root, bridgeFile), 'utf8');
    const mutated = contents.replace(
      '      - run: npm ci\n',
      '      - run: npm ci\n      - run: echo ${{ github.event.client_payload.version }}\n',
    );

    expect(mutated).not.toBe(contents);
    expect(collectReleaseBridgeIssues(bridgeFile, mutated)).toContain(
      `${bridgeFile}: step 5 interpolates an expression into a shell body`,
    );
  });

  it('reports a step that carries the registry token without publishing', () => {
    const contents = readFileSync(path.join(root, bridgeFile), 'utf8');
    const mutated = contents.replace(
      '      - run: npm run smoke\n',
      '      - run: npm run smoke\n        env:\n          NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}\n',
    );

    expect(mutated).not.toBe(contents);
    const issues = collectReleaseBridgeIssues(bridgeFile, mutated);
    expect(issues.some((issue) => issue.includes('carries the registry token without publishing'))).toBe(true);
  });

  it('reports a step that publishes through another registry', () => {
    const contents = readFileSync(path.join(root, bridgeFile), 'utf8');
    const mutated = contents.replace('npm run smoke', 'npm run smoke --registry=https://example.invalid');

    expect(mutated).not.toBe(contents);
    expect(collectReleaseBridgeIssues(bridgeFile, mutated)).toContain(
      `${bridgeFile}: a step reads or publishes through https://example.invalid`,
    );
  });

  it('reports a workflow with no manual recovery inputs', () => {
    const contents = readFileSync(path.join(root, bridgeFile), 'utf8');
    const mutated = contents.replace(/ {2}workflow_dispatch:[\s\S]*?\n\npermissions:/u, '\npermissions:');

    expect(mutated).not.toBe(contents);
    expect(collectReleaseBridgeIssues(bridgeFile, mutated)).toContain(
      `${bridgeFile}: no manual dispatch inputs, so a lost delivery cannot be replayed`,
    );
  });
});

describe('collectReleaseWorkflowIssues', () => {
  // The manual release publishes the same package as the bridge, so a per-ref group would let the two run
  // at once. This is the concrete overlap between them, and the reason both name the same group.
  it('accepts the manual release this repository ships', () => {
    const contents = readFileSync(path.join(root, releaseFile), 'utf8');

    expect(collectReleaseWorkflowIssues(releaseFile, contents)).toEqual([]);
  });

  it('reports a manual release that could publish concurrently with the bridge', () => {
    const contents = readFileSync(path.join(root, releaseFile), 'utf8');
    const mutated = contents.replace('group: release-global', 'group: release-${{ github.ref }}');

    expect(mutated).not.toBe(contents);
    expect(collectReleaseWorkflowIssues(releaseFile, mutated)).toContain(
      `${releaseFile}: concurrency group is release-\${{ github.ref }} rather than release-global`,
    );
  });
});
