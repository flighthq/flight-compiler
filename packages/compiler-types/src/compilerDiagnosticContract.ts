export interface CompilerDiagnostic {
  readonly code: string;
  readonly column: number;
  readonly line: number;
  readonly message: string;
  readonly source: string;
}
