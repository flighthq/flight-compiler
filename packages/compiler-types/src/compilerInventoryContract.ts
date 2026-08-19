export type ExportKind = 'class' | 'default' | 'enum' | 'function' | 'interface' | 'namespace' | 'type' | 'variable';

export interface RuntimeBindingRecord {
  readonly fingerprint: string;
  readonly kind: ExportKind;
  readonly source: string;
}

export interface ExportRecord {
  readonly fingerprint: string;
  readonly kind: ExportKind;
  readonly name: string;
  readonly runtime: boolean;
  readonly runtimeBinding?: RuntimeBindingRecord | undefined;
  readonly source: string;
}

export interface ExportConflict {
  readonly name: string;
  readonly sources: readonly string[];
}

export interface PackageExportCondition {
  readonly condition: string;
  readonly source: string;
  readonly target: string;
}

export interface PackageExportLane {
  readonly conditions: readonly PackageExportCondition[];
  readonly entry: string;
  readonly exportConflicts: readonly ExportConflict[];
  readonly exports: readonly ExportRecord[];
  readonly source: string;
  readonly specifier: string;
}

export interface SdkExposure {
  readonly sdkLane: string;
  readonly target: string;
}

export interface PackageInventory {
  readonly dependencies: readonly string[];
  readonly directory: string;
  readonly exportLanes: readonly PackageExportLane[];
  readonly name: string;
  readonly sdkExposures: readonly SdkExposure[];
  readonly sdkIncluded: boolean;
  readonly sourceFiles: number;
  readonly testFiles: number;
  readonly version: string;
}

export interface UpstreamInventory {
  readonly packages: readonly PackageInventory[];
  readonly schema: 'flight-compiler-inventory/1';
  readonly summary: {
    readonly exportConflicts: number;
    readonly exportLanes: number;
    readonly exports: number;
    readonly packages: number;
    readonly rootExports: number;
    readonly sourceFiles: number;
    readonly testFiles: number;
  };
  readonly upstreamCommit: string;
}

export interface AnalyzeFlightWorkspaceOptions {
  readonly packageScope?: string | undefined;
  readonly packagesDirectory?: string | undefined;
  readonly sdkPackageName?: string | undefined;
  readonly tsconfigPath?: string | undefined;
  readonly upstreamDirectory: string;
}

export interface PackageExportDescriptor {
  readonly conditions: readonly PackageExportCondition[];
  readonly entry: string;
  readonly source: string;
  readonly specifier: string;
}
