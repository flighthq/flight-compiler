import type { CompilerSourceFingerprint } from './compilerSourceFingerprint.js';
import type { WorkspaceSource } from './compilerWorkspaceSourceContract.js';

export type ExportKind = 'class' | 'default' | 'enum' | 'function' | 'interface' | 'namespace' | 'type' | 'variable';

export interface RuntimeBindingRecord {
  readonly fingerprint: CompilerSourceFingerprint;
  readonly kind: ExportKind;
  readonly source: string;
}

export interface ExportRecord {
  readonly fingerprint: CompilerSourceFingerprint;
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

export interface PackageBinEntry {
  readonly name: string;
  readonly target: string;
}

export type FlightPackageEnvironment = 'capacitor' | 'electron' | 'node' | 'tauri' | 'web';

export interface FlightPackageManifest {
  readonly bins: readonly PackageBinEntry[];
  readonly dependencies: readonly string[];
  readonly directory: string;
  readonly environment?: FlightPackageEnvironment | undefined;
  readonly name: string;
  readonly version: string;
}

export type PackageImportKind = 'dynamic' | 'import' | 'importEquals' | 'reexport';

export interface PackageImportRecord {
  readonly kind: PackageImportKind;
  readonly source: string;
  readonly specifier: string;
  readonly typeOnly: boolean;
}

export type PackageHostKind = 'capacitor' | 'electron' | 'node' | 'playwright' | 'tauri';

export interface PackageHostModuleReference {
  readonly kind: PackageHostKind;
  readonly specifier: string;
}

export interface PackageHostFacts {
  readonly dependencies: readonly PackageHostModuleReference[];
  readonly imports: readonly PackageHostModuleReference[];
}

export interface PackageExclusionEvidence {
  readonly bins: readonly PackageBinEntry[];
  readonly hostDependencies: readonly PackageHostModuleReference[];
  readonly hostImports: readonly PackageHostModuleReference[];
  readonly sdkExposures: readonly SdkExposure[];
}

export interface PackageExclusion {
  readonly evidence: PackageExclusionEvidence;
  readonly reason: string;
  readonly rule: 'node-playwright-tooling' | 'node-tooling';
}

export interface FlightPackageEligibilityPackage {
  readonly dependencies: readonly string[];
  readonly environment?: FlightPackageEnvironment | undefined;
  readonly name: string;
}

export interface PackageInventory extends FlightPackageEligibilityPackage {
  readonly bins: readonly PackageBinEntry[];
  readonly directory: string;
  readonly exclusion: PackageExclusion | null;
  readonly exportLanes: readonly PackageExportLane[];
  readonly hostFacts: PackageHostFacts;
  readonly imports: readonly PackageImportRecord[];
  readonly sdkExposures: readonly SdkExposure[];
  readonly sdkIncluded: boolean;
  readonly sourceFiles: number;
  readonly testFiles: number;
  readonly version: string;
}

export interface FlightPackageEligibilityOptions {
  readonly environment?: FlightPackageEnvironment | undefined;
  readonly packages: readonly Readonly<FlightPackageEligibilityPackage>[];
  readonly selectedPackageNames: readonly string[];
}

export interface FlightPackageEligibilityPlan {
  readonly eligiblePackageNames: readonly string[];
  readonly environment: FlightPackageEnvironment | null;
  readonly schema: 'flight-compiler-package-eligibility/1';
}

export interface FlightPackageEligibilitySubsetExcludedRoot {
  readonly dependencyPath: readonly string[];
  readonly name: string;
  readonly requiredEnvironment: FlightPackageEnvironment;
  readonly selectedEnvironment: FlightPackageEnvironment | null;
}

export interface FlightPackageEligibilitySubsetOptions {
  readonly candidatePackageNames: readonly string[];
  readonly environment?: FlightPackageEnvironment | undefined;
  readonly packages: readonly Readonly<FlightPackageEligibilityPackage>[];
}

export interface FlightPackageEligibilitySubsetPlan {
  readonly environment: FlightPackageEnvironment | null;
  readonly excludedRoots: readonly FlightPackageEligibilitySubsetExcludedRoot[];
  readonly includedPackageNames: readonly string[];
  readonly schema: 'flight-compiler-package-eligibility-subset/1';
}

export type FlightPackageEligibilityFailureCode =
  | 'duplicate-package'
  | 'ineligible-package-environment'
  | 'invalid-environment'
  | 'invalid-package'
  | 'invalid-selection'
  | 'unknown-package';

export interface FlightPackageEligibilityFailure extends Error {
  readonly code: FlightPackageEligibilityFailureCode;
  readonly dependencyPath?: readonly string[] | undefined;
  readonly kind: 'flight-package-eligibility';
  readonly requiredEnvironment?: FlightPackageEnvironment | undefined;
  readonly selectedEnvironment?: FlightPackageEnvironment | null | undefined;
  readonly subject: string;
}

export interface UpstreamInventory {
  readonly packages: readonly PackageInventory[];
  readonly schema: 'flight-compiler-inventory/2';
  readonly summary: {
    readonly exportConflicts: number;
    readonly exportLanes: number;
    readonly excludedPackages: number;
    readonly exports: number;
    readonly hostDependencies: number;
    readonly hostImports: number;
    readonly packages: number;
    readonly productionImports: number;
    readonly rootExports: number;
    readonly sourceFiles: number;
    readonly testFiles: number;
  };
  readonly upstreamCommit: string;
}

export interface AnalyzeFlightWorkspaceOptions {
  readonly expectedExclusionPackageNames?: readonly string[] | undefined;
  // Absent means the host filesystem. Supplying one lets a caller analyse a workspace that is not on
  // disk, and lets analysis be exercised without a temporary directory.
  readonly source?: WorkspaceSource | undefined;
  readonly packageScope?: string | undefined;
  readonly packagesDirectory?: string | undefined;
  readonly sdkPackageName?: string | undefined;
  /** Explicit package closure to return and subject to tooling-exclusion policy. */
  readonly targetPackageNames?: readonly string[] | undefined;
  readonly tsconfigPath?: string | undefined;
  readonly upstreamDirectory: string;
}

export interface AnalyzeFlightPackageExclusionsOptions {
  readonly expectedPackageNames?: readonly string[] | undefined;
  readonly packages: readonly Readonly<PackageInventory>[];
}

export interface ReadFlightPackageManifestsOptions {
  readonly packageScope?: string | undefined;
  readonly packagesDirectory?: string | undefined;
  readonly upstreamDirectory: string;
}

export interface AnalyzeFlightPackageImportsOptions {
  readonly manifest: Readonly<FlightPackageManifest>;
  readonly upstreamDirectory: string;
}

export type CompilerInventoryFailureCode =
  | 'ambiguous-export'
  | 'duplicate-package-name'
  | 'invalid-git-commit'
  | 'invalid-host-endpoint-receiver'
  | 'invalid-package-directory'
  | 'invalid-package-export'
  | 'invalid-package-manifest'
  | 'invalid-package-scope'
  | 'invalid-source-path'
  | 'invalid-typescript-project'
  | 'missing-package-export'
  | 'missing-packages-directory'
  | 'missing-sdk-package'
  | 'package-exclusion-drift'
  | 'runtime-export-classification'
  | 'unknown-package'
  | 'unresolved-export'
  | 'unresolved-source'
  | 'unsupported-package-specifier'
  | 'unsupported-dynamic-import';

export interface CompilerInventoryFailure extends Error {
  readonly code: CompilerInventoryFailureCode;
  readonly kind: 'compiler-inventory';
  readonly subject: string;
}

export interface PackageExportDescriptor {
  readonly conditions: readonly PackageExportCondition[];
  readonly entry: string;
  readonly source: string;
  readonly specifier: string;
}
