import type { CompilerPackageCompilationRefusalCode } from './compilerPackageCompilationContract.js';
import type { CompilerRefusalClassification } from './compilerRefusalClassificationContract.js';
import type { CompilerModuleIdentity } from './compilerSourceIdentity.js';
import type { CompilerTypeScriptAnalysisIdentity } from './compilerTypeScriptContract.js';

export interface CompilerPackageCheckArtifactProvenance {
  readonly name: string;
  readonly revision: string;
}

export interface CompilerPackageCheckBaseline {
  readonly findingIdentities: readonly string[];
  readonly schema: 'flight-compiler-check-baseline/1';
}

export interface CompilerPackageCheckCascade {
  readonly directFindingIdentities: readonly string[];
  readonly module: CompilerModuleIdentity;
}

export interface CompilerPackageCheckClassificationTable {
  /** Caller overrides for stable refusal codes. Producer attribution supplies the default. */
  readonly codes?: Readonly<Partial<Record<CompilerPackageCompilationRefusalCode, CompilerPackageCheckPolicyClass>>>;
  /** Caller overrides for exact stable refusal rules. Producer attribution supplies the default. */
  readonly rules?: Readonly<Record<string, CompilerPackageCheckPolicyClass>>;
  readonly schema: 'flight-compiler-check-classification/1';
}

export interface CompilerPackageCheckComparison {
  readonly introduced: readonly CompilerPackageCheckFinding[];
  readonly resolvedFindingIdentities: readonly string[];
  readonly schema: 'flight-compiler-check-comparison/1';
  readonly unchanged: readonly CompilerPackageCheckFinding[];
}

export interface CompilerPackageCheckFinding {
  readonly code: CompilerPackageCheckFindingCode;
  readonly identity: string;
  readonly module: CompilerModuleIdentity;
  readonly occurrences: readonly CompilerPackageCheckFindingOccurrence[];
  readonly policyClass: CompilerPackageCheckPolicyClass;
  readonly rule?: string | undefined;
  readonly stage: 'emission' | 'initialization' | 'lowering';
}

export type CompilerPackageCheckFindingCode = Exclude<CompilerPackageCompilationRefusalCode, 'dependency-refused'>;

export interface CompilerPackageCheckFindingOccurrence {
  readonly column?: number | undefined;
  readonly line?: number | undefined;
  readonly message: string;
}

export interface CompilerPackageCheckModuleTotals {
  readonly dependencyRefused: number;
  readonly directlyRefused: number;
  readonly emitted: number;
  readonly total: number;
}

export interface CompilerPackageCheckOptions {
  readonly classification?: Readonly<CompilerPackageCheckClassificationTable> | undefined;
  readonly provenance: Readonly<CompilerPackageCheckProvenance>;
}

export interface CompilerPackageCheckPackageSummary {
  readonly dependencyCascades: number;
  readonly directFindings: number;
  readonly directOccurrences: number;
  readonly findingsByPolicy: Readonly<Record<CompilerPackageCheckPolicyClass, number>>;
  readonly modules: CompilerPackageCheckModuleTotals;
  readonly name: string;
}

export interface CompilerPackageCheckPolicy {
  readonly failOnIntroduced: readonly CompilerPackageCheckPolicyClass[];
  readonly id: string;
  readonly schema: 'flight-compiler-check-policy/1';
}

export type CompilerPackageCheckPolicyClass = CompilerRefusalClassification;

export interface CompilerPackageCheckPolicyResult {
  readonly failingFindingIdentities: readonly string[];
  readonly passed: boolean;
  readonly policy: CompilerPackageCheckPolicy;
  readonly schema: 'flight-compiler-check-policy-result/1';
}

export interface CompilerPackageCheckProvenance {
  readonly compiler: CompilerPackageCheckArtifactProvenance;
  readonly target: CompilerPackageCheckArtifactProvenance;
  readonly upstream: CompilerPackageCheckArtifactProvenance;
}

export interface CompilerPackageCheckReport {
  readonly backend: string;
  readonly cascades: readonly CompilerPackageCheckCascade[];
  readonly directFindings: readonly CompilerPackageCheckFinding[];
  readonly packages: readonly CompilerPackageCheckPackageSummary[];
  readonly provenance: CompilerPackageCheckProvenance;
  readonly schema: 'flight-compiler-check-report/1';
  readonly totals: Readonly<{
    readonly dependencyCascades: number;
    readonly directFindings: number;
    readonly directOccurrences: number;
    readonly modules: CompilerPackageCheckModuleTotals;
    readonly packages: number;
  }>;
  readonly typescript: CompilerTypeScriptAnalysisIdentity;
}
