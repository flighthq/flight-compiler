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

export interface CompilerSourceOrigin extends CompilerSourceIdentity {
  readonly column: number;
  readonly fingerprint: string;
  readonly line: number;
}
