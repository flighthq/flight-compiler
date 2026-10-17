import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { findRustCompilerToolchain, type RustCompilerToolchain } from './rustToolchain.js';

export interface RustMaturityCheckpointCapabilities {
  readonly environment: Readonly<NodeJS.ProcessEnv>;
  readonly findToolchain: (
    options: Readonly<{ link: boolean }>,
    environment: Readonly<NodeJS.ProcessEnv>,
  ) => RustCompilerToolchain | undefined;
  readonly rootDirectory: string;
  readonly runProcess: (
    command: string,
    arguments_: readonly string[],
    options: Readonly<{ cwd: string; environment: Readonly<NodeJS.ProcessEnv> }>,
  ) => Readonly<RustMaturityCheckpointProcessResult>;
  readonly vitestCommand: string;
}

export interface RustMaturityCheckpointProcessResult {
  readonly errorMessage?: string | undefined;
  readonly status: number | null;
}

export interface RustMaturityCheckpointResult {
  readonly files: readonly string[];
  readonly summary: string;
}

export function runRustMaturityCheckpoint(
  capabilities: Readonly<RustMaturityCheckpointCapabilities>,
): RustMaturityCheckpointResult {
  const environment = { ...capabilities.environment, FLIGHT_RUST_REQUIRE_RUSTC: '1' };
  const toolchain = capabilities.findToolchain({ link: false }, environment);
  if (toolchain === undefined) throw new Error('required Rust compiler rustc is not available');

  const result = capabilities.runProcess(
    capabilities.vitestCommand,
    ['run', ...rustMaturityCheckpointFiles, '--no-file-parallelism', '--maxWorkers=1', '--reporter=dot'],
    { cwd: capabilities.rootDirectory, environment },
  );
  if (result.errorMessage !== undefined) {
    throw new RustMaturityCheckpointChildFailure(`Rust maturity checkpoint could not start: ${result.errorMessage}`, 1);
  }
  if (result.status !== 0) {
    throw new RustMaturityCheckpointChildFailure(
      `Rust maturity checkpoint tests exited with status ${result.status === null ? 'unknown' : String(result.status)}`,
      result.status ?? 1,
    );
  }

  return {
    files: [...rustMaturityCheckpointFiles],
    summary: `Rust maturity checkpoint passed: rustc verified; ${String(rustMaturityCheckpointFiles.length)} focused test files passed with one Vitest worker.\n`,
  };
}

class RustMaturityCheckpointChildFailure extends Error {
  constructor(
    message: string,
    readonly exitCode: number,
  ) {
    super(message);
    this.name = 'RustMaturityCheckpointChildFailure';
  }
}

const rustMaturityCheckpointFiles = [
  'packages/compiler-backend-rs/src/rustCompilerBackend.test.ts',
  'packages/compiler-backend-rs/src/rustRuntimeExternalConstructorAbi.test.ts',
] as const;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const vitest = path.join(root, 'node_modules', '.bin', process.platform === 'win32' ? 'vitest.cmd' : 'vitest');
const entryPath = process.argv[1] === undefined ? undefined : path.resolve(process.argv[1]);

if (entryPath === fileURLToPath(import.meta.url)) {
  try {
    const result = runRustMaturityCheckpoint({
      environment: process.env,
      findToolchain: (options, environment) => findRustCompilerToolchain(options, environment),
      rootDirectory: root,
      runProcess: (command, arguments_, options) => {
        const child = spawnSync(command, [...arguments_], {
          cwd: options.cwd,
          env: { ...options.environment },
          stdio: 'inherit',
        });
        return {
          ...(child.error === undefined ? {} : { errorMessage: child.error.message }),
          status: child.status,
        };
      },
      vitestCommand: vitest,
    });
    process.stdout.write(result.summary);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = error instanceof RustMaturityCheckpointChildFailure ? error.exitCode : 1;
  }
}
