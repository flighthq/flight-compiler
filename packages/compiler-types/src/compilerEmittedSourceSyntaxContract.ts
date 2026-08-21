import type { EmittedFile, EmittedFileIdentity } from './compilerBackendContract.js';

export interface CompilerEmittedSourceParserDiagnostic {
  readonly code: string;
  /** One-based source column reported by the parser. */
  readonly column: number;
  /** One-based source line reported by the parser. */
  readonly line: number;
  readonly message: string;
}

export interface CompilerEmittedSourceSyntaxDiagnostic
  extends CompilerEmittedSourceParserDiagnostic, EmittedFileIdentity {}

export interface CompilerEmittedSourceParser {
  readonly name: string;
  /** Returns syntax diagnostics; operational parser failures remain thrown errors. */
  readonly parseEmittedSource: (file: Readonly<EmittedFile>) => readonly CompilerEmittedSourceParserDiagnostic[];
  readonly supportsEmittedSource: (file: Readonly<EmittedFileIdentity>) => boolean;
}

export interface CompilerEmittedSourceSyntaxReport {
  readonly checkedFiles: number;
  readonly parser: string;
  readonly skippedFiles: readonly string[];
}

export interface CompilerEmittedSourceSyntaxFailure extends Error {
  readonly diagnostics: readonly CompilerEmittedSourceSyntaxDiagnostic[];
  readonly kind: 'emitted-source-syntax';
  readonly parser: string;
}
