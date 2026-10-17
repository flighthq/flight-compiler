import { describe, expect, it } from 'vitest';

import {
  runRustMaturityCheckpoint,
  type RustMaturityCheckpointCapabilities,
  type RustMaturityCheckpointProcessResult,
} from './rustMaturityCheckpoint.js';
import { findRustCompilerToolchain } from './rustToolchain.js';

describe('runRustMaturityCheckpoint', () => {
  it('requires a verified rustc before starting the focused tests', () => {
    let processRuns = 0;
    const capabilities = createCapabilities({
      findToolchain: (options, environment) => findRustCompilerToolchain(options, environment, () => false),
      runProcess: () => {
        processRuns += 1;
        return { status: 0 };
      },
    });

    expect(() => runRustMaturityCheckpoint(capabilities)).toThrow('required Rust compiler rustc is not available');
    expect(processRuns).toBe(0);
  });

  it('runs the exact maturity files with required rustc and one Vitest worker', () => {
    const calls: Array<
      Readonly<{
        arguments_: readonly string[];
        command: string;
        options: Readonly<{ cwd: string; environment: Readonly<NodeJS.ProcessEnv> }>;
      }>
    > = [];
    const environment = { CHECKPOINT_PARENT: 'preserved' };
    const capabilities = createCapabilities({
      environment,
      findToolchain: (options, requiredEnvironment) => {
        expect(options).toEqual({ link: false });
        expect(requiredEnvironment).toEqual({ CHECKPOINT_PARENT: 'preserved', FLIGHT_RUST_REQUIRE_RUSTC: '1' });
        return { rustc: 'rustc' };
      },
      runProcess: (command, arguments_, options) => {
        calls.push({ arguments_, command, options });
        return { status: 0 };
      },
    });

    const first = runRustMaturityCheckpoint(capabilities);
    const second = runRustMaturityCheckpoint(capabilities);

    expect(first).toEqual({
      files: [
        'packages/compiler-backend-rs/src/rustCompilerBackend.test.ts',
        'packages/compiler-backend-rs/src/rustRuntimeExternalConstructorAbi.test.ts',
      ],
      summary: 'Rust maturity checkpoint passed: rustc verified; 2 focused test files passed with one Vitest worker.\n',
    });
    expect(second).toEqual(first);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toEqual({
      arguments_: [
        'run',
        'packages/compiler-backend-rs/src/rustCompilerBackend.test.ts',
        'packages/compiler-backend-rs/src/rustRuntimeExternalConstructorAbi.test.ts',
        '--no-file-parallelism',
        '--maxWorkers=1',
        '--reporter=dot',
      ],
      command: '/workspace/node_modules/.bin/vitest',
      options: {
        cwd: '/workspace',
        environment: { CHECKPOINT_PARENT: 'preserved', FLIGHT_RUST_REQUIRE_RUSTC: '1' },
      },
    });
    expect(environment).toEqual({ CHECKPOINT_PARENT: 'preserved' });
  });

  it.each([
    [{ status: 7 }, 'Rust maturity checkpoint tests exited with status 7', 7],
    [{ status: null }, 'Rust maturity checkpoint tests exited with status unknown', 1],
    [{ errorMessage: 'spawn denied', status: null }, 'Rust maturity checkpoint could not start: spawn denied', 1],
  ] as const)('propagates a failed child process %#', (processResult, message, exitCode) => {
    let failure: unknown;
    try {
      runRustMaturityCheckpoint(createCapabilities({ runProcess: () => processResult }));
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(Error);
    expect(failure).toMatchObject({ exitCode, message });
  });
});

function createCapabilities(
  overrides: Partial<RustMaturityCheckpointCapabilities> = {},
): RustMaturityCheckpointCapabilities {
  return {
    environment: {},
    findToolchain: () => ({ rustc: 'rustc' }),
    rootDirectory: '/workspace',
    runProcess: (): RustMaturityCheckpointProcessResult => ({ status: 0 }),
    vitestCommand: '/workspace/node_modules/.bin/vitest',
    ...overrides,
  };
}
