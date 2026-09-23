// Pointing the compiler at a directory, as data rather than as process state.
//
// The filesystem and the output stream arrive as capabilities so that the decision layer — which
// modules to compile, what to report, what to exit with — can be exercised without a disk.
import type { FlightPackageEligibilitySubsetExcludedRoot } from './compilerInventoryContract.js';
import type {
  CompilerPackageCheckComparison,
  CompilerPackageCheckPolicyResult,
  CompilerPackageCheckProvenance,
  CompilerPackageCheckReport,
} from './compilerPackageCheckContract.js';
import type { CompilerPackageCompilationRefusalCode } from './compilerPackageCompilationContract.js';
import type { WorkspaceSource } from './compilerWorkspaceSourceContract.js';

export interface CompilerCommandLineRequest {
  readonly argv: readonly string[];
}

export interface CompilerCommandLineSource {
  readonly contents: string;
  /** How the module is named in a report; the source path relative to the directory compiled. */
  readonly moduleName: string;
  readonly sourcePath: string;
}

export interface CompilerCommandLineCapabilities {
  readonly listSourceFiles: (directory: string) => readonly CompilerCommandLineSource[];
  readonly write: (text: string) => void;
  readonly writeError: (text: string) => void;
  readonly writeOutputFile: (directory: string, relativePath: string, contents: string) => void;
}

export interface CompilerCommandLineRefusal {
  readonly code: CompilerPackageCompilationRefusalCode;
  readonly column?: number | undefined;
  readonly line?: number | undefined;
  readonly module: string;
  readonly reason: string;
  readonly stage: 'dependency' | 'emission' | 'initialization' | 'lowering';
}

export interface CompilerCommandLineResult {
  readonly emitted: number;
  readonly exitCode: number;
  readonly refusals: readonly CompilerCommandLineRefusal[];
}

// Checking a workspace, as data rather than as a build.
//
// Check mode asks the same deterministic compilation the emit path runs, through the workspace seam: the
// inventory reads the packages, the eligibility plan decides which are in scope, and the check package
// derives the report, the baseline comparison, and the policy verdict. What is left here is the
// invocation around them. The judgments a check makes -- which packages are in scope, which findings
// gate, what an earlier run already knew -- are supplied or derived explicitly, because none of them can
// be read off the refusals themselves. The capability record has no output-directory member, so "writes
// nothing" is a property of the shape rather than a promise in the text.
export interface CompilerCommandLineCheckRequest {
  readonly argv: readonly string[];
}

export type CompilerCommandLineCheckFormat = 'json' | 'text';

export interface CompilerCommandLineCheckCapabilities {
  /** The baseline file's text, or undefined when the file is not there. Never called to write one. */
  readonly readBaseline: (path: string) => string | undefined;
  /**
   * What produced this run, whole. A caller that knows the compiler, target, and upstream revisions --
   * a corpus run pinning a checkout -- supplies them here, and they are recorded as given.
   */
  readonly readProvenance?: (() => CompilerPackageCheckProvenance) | undefined;
  /**
   * The revision of the workspace being checked, when the caller can establish one. A Git checkout has
   * one; a scratch directory does not, and answering undefined records `unversioned` rather than a guess.
   */
  readonly readUpstreamRevision?: ((workspace: string) => string | undefined) | undefined;
  /**
   * The packages the workspace itself depends on directly -- what a run with no `--package` takes as its
   * candidate roots. Reading them is the edge's job, like every other workspace fact.
   */
  readonly readWorkspaceRoots: (workspace: string) => readonly string[];
  /** The workspace the run reads: the same four-operation capability the inventory reads through. */
  readonly workspaceSource: WorkspaceSource;
  readonly write: (text: string) => void;
  readonly writeError: (text: string) => void;
  readonly writeReportFile: (path: string, contents: string) => void;
}

// A run that happened: the compilation report and the two judgments made over it. Absent baseline means an
// empty one, so every finding is introduced and nothing is resolved -- which is what "no baseline" means.
export interface CompilerCommandLineCheckOutcome {
  readonly comparison: CompilerPackageCheckComparison;
  /** The packages the eligibility plan put in scope, sorted. */
  readonly eligiblePackageNames: readonly string[];
  /**
   * Workspace roots left out because they require an environment this run did not select. A selection
   * fact rather than a compiler finding: nothing was compiled for them, so there is nothing to report.
   */
  readonly excludedRoots: readonly FlightPackageEligibilitySubsetExcludedRoot[];
  readonly exitCode: 0 | 1;
  readonly policyResult: CompilerPackageCheckPolicyResult;
  readonly report: CompilerPackageCheckReport;
}

// A run that could not be carried out: the invocation was wrong, or the workspace could not be read, so
// there is no report to make claims about and nothing was compiled.
export interface CompilerCommandLineCheckRefusal {
  readonly exitCode: 2;
  readonly reason: string;
}

export type CompilerCommandLineCheckResult = CompilerCommandLineCheckOutcome | CompilerCommandLineCheckRefusal;
