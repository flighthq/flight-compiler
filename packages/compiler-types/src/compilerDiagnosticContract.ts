import type { CompilerSourceLocation } from './compilerSourceIdentity.js';

export type CompilerDiagnosticCode = 'unsupported-typescript';

export type CompilerDiagnosticSeverity = 'error' | 'warning';

// A diagnostic is attributed to the module whose lowering produced it, which is not always the
// module the offending syntax is written in: lowering follows declarations into imported modules and
// type-only re-export chains. Line and column are therefore optional, present exactly when the
// construct is in `source` itself, so a reader never pairs a position with the wrong text.
export interface CompilerDiagnostic extends Omit<CompilerSourceLocation, 'column' | 'line'> {
  readonly code: CompilerDiagnosticCode;
  readonly column?: number;
  readonly line?: number;
  readonly message: string;
  readonly severity: CompilerDiagnosticSeverity;
}
