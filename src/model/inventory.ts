export type ExportKind = 'class' | 'default' | 'enum' | 'function' | 'interface' | 'namespace' | 'type' | 'variable';

export interface RuntimeBindingRecord {
  fingerprint: string;
  kind: ExportKind;
  source: string;
}

export interface ExportRecord {
  fingerprint: string;
  kind: ExportKind;
  name: string;
  runtime: boolean;
  runtimeBinding?: RuntimeBindingRecord | undefined;
  source: string;
}

export interface ExportConflict {
  name: string;
  sources: string[];
}

export interface PackageExportCondition {
  condition: string;
  source: string;
  target: string;
}

export interface PackageExportLane {
  conditions: PackageExportCondition[];
  entry: string;
  exportConflicts: ExportConflict[];
  exports: ExportRecord[];
  source: string;
  specifier: string;
}

export interface SdkExposure {
  sdkLane: string;
  target: string;
}

export interface PackageInventory {
  dependencies: string[];
  directory: string;
  exportLanes: PackageExportLane[];
  name: string;
  sdkExposures: SdkExposure[];
  sdkIncluded: boolean;
  sourceFiles: number;
  testFiles: number;
  version: string;
}

export interface UpstreamInventory {
  packages: PackageInventory[];
  schema: 'flight-compiler-inventory/1';
  summary: {
    exportConflicts: number;
    exportLanes: number;
    exports: number;
    packages: number;
    rootExports: number;
    sourceFiles: number;
    testFiles: number;
  };
  upstreamCommit: string;
}

export interface AnalyzeFlightWorkspaceOptions {
  packageScope?: string | undefined;
  packagesDirectory?: string | undefined;
  sdkPackageName?: string | undefined;
  tsconfigPath?: string | undefined;
  upstreamDirectory: string;
}
