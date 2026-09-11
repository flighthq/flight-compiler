import type { CompilerSourceLocation } from './compilerSourceIdentity.js';

export type CompilerDiagnosticCode = 'unsupported-typescript';

export type CompilerDiagnosticSeverity = 'error' | 'warning';

export interface CompilerDiagnostic extends CompilerSourceLocation {
  readonly code: CompilerDiagnosticCode;
  readonly message: string;
  readonly severity: CompilerDiagnosticSeverity;
}
