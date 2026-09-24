import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { parseToolCompilerPublishArguments, publishToolCompilerPackage } from './toolCompilerPublish.js';
import type { ToolCompilerPublishCapabilities, ToolCompilerPublishProcessResult } from './toolCompilerPublish.js';

interface ProcessInvocation {
  readonly arguments_: readonly string[];
  readonly command: string;
  readonly options: Readonly<{ cwd: string; env: Readonly<NodeJS.ProcessEnv> }>;
}

const publishedManifest = {
  name: '@flighthq/tool-compiler',
  publishConfig: { access: 'public' },
  version: '1.2.3',
};

describe('parseToolCompilerPublishArguments', () => {
  it('defaults to the latest tag and accepts the explicit workflow forms', () => {
    expect(parseToolCompilerPublishArguments([])).toEqual({ dryRun: false, tag: 'latest' });
    expect(parseToolCompilerPublishArguments(['--tag', 'next'])).toEqual({ dryRun: false, tag: 'next' });
    expect(parseToolCompilerPublishArguments(['--dry-run', '--tag', 'latest'])).toEqual({
      dryRun: true,
      tag: 'latest',
    });
  });

  it.each([
    [['--dry-run', '--dry-run'], 'Duplicate tool-compiler publish option --dry-run'],
    [['--tag', 'next', '--tag', 'latest'], 'Duplicate tool-compiler publish option --tag'],
    [['--tag'], 'option --tag requires a value'],
    [['--tag', '--dry-run'], 'option --tag requires a value'],
    [['--tag=next'], 'Unknown tool-compiler publish option'],
    [['--unknown'], 'Unknown tool-compiler publish option'],
    [['package-name'], 'Unknown tool-compiler publish option'],
  ])('rejects duplicate, missing, and unknown options %#', (arguments_, message) => {
    expect(() => parseToolCompilerPublishArguments(arguments_)).toThrow(message);
  });

  it.each(['../latest', '-next', 'Next', 'next/latest', 'next latest', '1.2.3', 'next;echo'])(
    'rejects unsafe distribution tag %s',
    (tag) => {
      expect(() => parseToolCompilerPublishArguments(['--tag', tag])).toThrow('Unsafe npm distribution tag');
    },
  );

  it('does not mutate the caller argument array', () => {
    const arguments_ = ['--dry-run', '--tag', 'next'];
    const snapshot = [...arguments_];

    parseToolCompilerPublishArguments(arguments_);

    expect(arguments_).toEqual(snapshot);
  });
});

describe('publishToolCompilerPackage', () => {
  it('publishes an unpublished stamped package from its directory with exact argv and environment', () => {
    const fixture = createFixture([
      processResult(1, '', 'npm error code E404\nnpm error 404 Not Found'),
      processResult(0),
    ]);
    const options = { dryRun: false, tag: 'next' } as const;
    const optionsSnapshot = JSON.stringify(options);
    const environmentSnapshot = JSON.stringify(fixture.environment);

    const result = publishToolCompilerPackage(options, fixture.capabilities);

    expect(result).toEqual({
      kind: 'published',
      message: '[release] published @flighthq/tool-compiler@1.2.3 with tag next.\n',
      packageName: '@flighthq/tool-compiler',
      tag: 'next',
      version: '1.2.3',
    });
    expect(fixture.readFiles).toEqual([path.join('/repo', 'packages', 'tool-compiler', 'package.json')]);
    expect(fixture.invocations).toEqual([
      {
        arguments_: ['view', '@flighthq/tool-compiler', 'versions', '--json'],
        command: 'npm',
        options: {
          cwd: path.join('/repo', 'packages', 'tool-compiler'),
          env: fixture.environment,
        },
      },
      {
        arguments_: ['publish', '--access', 'public', '--tag', 'next'],
        command: 'npm',
        options: {
          cwd: path.join('/repo', 'packages', 'tool-compiler'),
          env: fixture.environment,
        },
      },
    ]);
    expect(JSON.stringify(options)).toBe(optionsSnapshot);
    expect(JSON.stringify(fixture.environment)).toBe(environmentSnapshot);
    expect(fixture.manifestText).toBe(`${JSON.stringify(publishedManifest)}\n`);
  });

  it('publishes the first version when npm --json reports package absence on stdout', () => {
    const fixture = createFixture([
      processResult(
        1,
        JSON.stringify({
          error: {
            code: 'E404',
            detail: "'@flighthq/tool-compiler@*' is not in this registry.",
            summary: 'Not Found',
          },
        }),
        'npm error code E404\nnpm error 404 Not Found',
      ),
      processResult(0),
    ]);

    expect(publishToolCompilerPackage({ dryRun: false, tag: 'latest' }, fixture.capabilities)).toMatchObject({
      kind: 'published',
      version: '1.2.3',
    });
    expect(fixture.invocations).toHaveLength(2);
  });

  it('skips an exact version already present on the registry without packing or publishing', () => {
    const fixture = createFixture([processResult(0, '["1.2.2","1.2.3"]')]);

    const result = publishToolCompilerPackage({ dryRun: false, tag: 'latest' }, fixture.capabilities);

    expect(result.kind).toBe('skipped');
    expect(result.message).toBe('[release] skip @flighthq/tool-compiler@1.2.3: version already published.\n');
    expect(fixture.invocations).toHaveLength(1);
  });

  it('dry-runs npm publish so the real prepack build and pack happen without an upload', () => {
    const fixture = createFixture([processResult(0, '[]'), processResult(0)]);

    const result = publishToolCompilerPackage({ dryRun: true, tag: 'latest' }, fixture.capabilities);

    expect(fixture.invocations[1]?.arguments_).toEqual([
      'publish',
      '--access',
      'public',
      '--tag',
      'latest',
      '--dry-run',
    ]);
    expect(result).toMatchObject({ kind: 'dry-run', tag: 'latest', version: '1.2.3' });
    expect(result.message).toContain('package built and packed; nothing uploaded');
  });

  it('accepts the prerelease versions produced by the version stamp', () => {
    const fixture = createFixture([processResult(0, '[]'), processResult(0)], {
      ...publishedManifest,
      version: '1.2.3-next.1',
    });

    const result = publishToolCompilerPackage({ dryRun: false, tag: 'next' }, fixture.capabilities);

    expect(result).toMatchObject({ kind: 'published', tag: 'next', version: '1.2.3-next.1' });
  });

  it('accepts a SemVer prerelease identifier that starts with digits and contains a letter', () => {
    const fixture = createFixture([processResult(0, '[]'), processResult(0)], {
      ...publishedManifest,
      version: '1.2.3-123abc',
    });

    expect(publishToolCompilerPackage({ dryRun: false, tag: 'next' }, fixture.capabilities)).toMatchObject({
      kind: 'published',
      version: '1.2.3-123abc',
    });
  });

  it('surfaces registry authentication or network failures instead of treating them as absence', () => {
    const fixture = createFixture([processResult(1, '', 'npm error code E401\nnpm error Unable to authenticate')]);

    expect(() => publishToolCompilerPackage({ dryRun: false, tag: 'latest' }, fixture.capabilities)).toThrow(
      'npm registry query failed (exit 1)',
    );
    expect(fixture.invocations).toHaveLength(1);
  });

  it.each([
    [
      'authentication JSON',
      processResult(
        1,
        JSON.stringify({ error: { code: 'E401', summary: 'Unable to authenticate' } }),
        'npm error code E401',
      ),
    ],
    [
      'network JSON',
      processResult(
        1,
        JSON.stringify({ error: { code: 'EAI_AGAIN', summary: 'getaddrinfo EAI_AGAIN registry.npmjs.org' } }),
        'npm error code EAI_AGAIN',
      ),
    ],
    ['near-match JSON', processResult(1, JSON.stringify({ error: { code: 'E404X' } }), 'npm error code E404X')],
    ['unstructured JSON', processResult(1, JSON.stringify({ code: 'E404' }), 'npm error code E404')],
    [
      'process launch failure',
      { ...processResult(null, JSON.stringify({ error: { code: 'E404' } })), errorMessage: 'spawn npm ENOENT' },
    ],
  ])('does not treat %s as first-publication package absence', (_label, registryResult) => {
    const fixture = createFixture([registryResult]);

    expect(() => publishToolCompilerPackage({ dryRun: false, tag: 'latest' }, fixture.capabilities)).toThrow(
      'npm registry query failed',
    );
    expect(fixture.invocations).toHaveLength(1);
  });

  it('surfaces invalid registry JSON instead of treating it as an empty version list', () => {
    const fixture = createFixture([processResult(0, '{not-json')]);

    expect(() => publishToolCompilerPackage({ dryRun: false, tag: 'latest' }, fixture.capabilities)).toThrow(
      'npm registry query returned invalid JSON',
    );
    expect(fixture.invocations).toHaveLength(1);
  });

  it('surfaces publish failure with npm output after a successful registry query', () => {
    const fixture = createFixture([
      processResult(0, '[]'),
      processResult(1, '', 'npm error code E403\nnpm error publish forbidden'),
    ]);

    expect(() => publishToolCompilerPackage({ dryRun: false, tag: 'latest' }, fixture.capabilities)).toThrow(
      'npm publish failed for @flighthq/tool-compiler@1.2.3 (exit 1)',
    );
    expect(fixture.invocations).toHaveLength(2);
  });

  it('does not mutate caller-owned options, environment, or process results', () => {
    const registryResult = processResult(0, '[]');
    const publishResult = processResult(0);
    const processSnapshot = JSON.stringify([registryResult, publishResult]);
    const fixture = createFixture([registryResult, publishResult]);
    const options = { dryRun: false, tag: 'latest' } as const;
    const optionsSnapshot = JSON.stringify(options);
    const environmentSnapshot = JSON.stringify(fixture.environment);

    publishToolCompilerPackage(options, fixture.capabilities);

    expect(JSON.stringify(options)).toBe(optionsSnapshot);
    expect(JSON.stringify(fixture.environment)).toBe(environmentSnapshot);
    expect(JSON.stringify([registryResult, publishResult])).toBe(processSnapshot);
  });

  it.each([
    [{ ...publishedManifest, name: '@flighthq/not-the-compiler' }, 'must be named @flighthq/tool-compiler'],
    [{ ...publishedManifest, private: true }, 'must be public'],
    [{ ...publishedManifest, private: 'false' }, 'must be public'],
    [{ name: '@flighthq/tool-compiler', version: '1.2.3' }, 'must declare publishConfig.access as public'],
    [{ ...publishedManifest, publishConfig: { access: 'restricted' } }, 'must declare publishConfig.access as public'],
    [{ ...publishedManifest, version: '1.2.3+local' }, 'has an invalid stamped version'],
    [{ ...publishedManifest, version: '1.2.3-01' }, 'has an invalid stamped version'],
  ])('rejects a package that is not the exact public stamped artifact %#', (manifest, message) => {
    const fixture = createFixture([], manifest);

    expect(() => publishToolCompilerPackage({ dryRun: false, tag: 'latest' }, fixture.capabilities)).toThrow(message);
    expect(fixture.invocations).toEqual([]);
  });
});

function createFixture(
  processResults: readonly Readonly<ToolCompilerPublishProcessResult>[],
  manifest: Readonly<Record<string, unknown>> = publishedManifest,
) {
  const environment = {
    NODE_AUTH_TOKEN: 'registry-token-placeholder',
    NPM_CONFIG_PROVENANCE: 'true',
    PATH: '/tools',
  };
  const invocations: ProcessInvocation[] = [];
  const readFiles: string[] = [];
  const remainingResults = [...processResults];
  const manifestText = `${JSON.stringify(manifest)}\n`;
  const capabilities: ToolCompilerPublishCapabilities = {
    environment,
    npmCommand: 'npm',
    readTextFile(file) {
      readFiles.push(file);
      return manifestText;
    },
    rootDirectory: '/repo',
    runProcess(command, arguments_, options) {
      invocations.push({ arguments_: [...arguments_], command, options });
      const result = remainingResults.shift();
      if (!result) throw new Error(`Unexpected process invocation: ${command} ${arguments_.join(' ')}`);
      return result;
    },
  };
  return { capabilities, environment, invocations, manifestText, readFiles };
}

function processResult(status: number | null, stdout = '', stderr = ''): ToolCompilerPublishProcessResult {
  return { status, stderr, stdout };
}
