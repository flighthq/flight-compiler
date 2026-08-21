import type { EmittedFile, EmittedFileIdentity } from './compilerBackendContract.js';

export interface CompilerTargetCompilationSmokeDiagnostic extends EmittedFileIdentity {
  readonly code: string;
  /** One-based source column reported by the target compiler. */
  readonly column: number;
  /** One-based source line reported by the target compiler. */
  readonly line: number;
  readonly message: string;
}

export interface CompilerTargetCompilationSmoke {
  /** Returns compiler diagnostics for the complete supported file set; process failures remain thrown errors. */
  readonly compileEmittedSources: (
    files: readonly Readonly<EmittedFile>[],
  ) => readonly CompilerTargetCompilationSmokeDiagnostic[];
  readonly name: string;
  readonly supportsEmittedSource: (file: Readonly<EmittedFileIdentity>) => boolean;
}

export interface CompilerTargetCompilationSmokeReport {
  readonly checkedFiles: number;
  readonly compiler: string;
  readonly skippedFiles: readonly string[];
}

export interface CompilerTargetCompilationSmokeFailure extends Error {
  readonly compiler: string;
  readonly diagnostics: readonly CompilerTargetCompilationSmokeDiagnostic[];
  readonly kind: 'target-compilation-smoke';
}
