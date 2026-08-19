export interface CompilerSourceIdentity {
  readonly packageName: string;
  readonly source: string;
}

export interface CompilerModuleIdentity extends CompilerSourceIdentity {
  readonly name: string;
}

export interface CompilerExportIdentity extends CompilerSourceIdentity {
  readonly exportName: string;
}

export interface CompilerSourceLocation extends CompilerSourceIdentity {
  /** One-based source column. */
  readonly column: number;
  /** One-based source line. */
  readonly line: number;
}

export interface CompilerSourceOrigin extends CompilerSourceLocation {
  readonly fingerprint: string;
}
