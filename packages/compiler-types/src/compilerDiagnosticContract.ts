import type { CompilerSourceLocation } from './compilerSourceIdentity.js';

export type CompilerDiagnosticCode = 'unsupported-typescript';

export interface CompilerDiagnostic extends CompilerSourceLocation {
  readonly code: CompilerDiagnosticCode;
  readonly message: string;
}
