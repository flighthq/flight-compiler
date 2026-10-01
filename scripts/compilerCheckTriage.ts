// Invert a package-check report from "which roots blocked this module" to "what does each root block".
//
// The check report already resolves dependency cascades to stable direct-finding identities. This analysis
// preserves those identities, ranks them by reverse fan-out, and separately computes the modules a proposed
// fix would unlock exactly. The separation matters: a cascade that names two roots contributes to both roots'
// fan-out, but fixing either root alone does not unlock it.

export type CompilerCheckTriageOwner = 'compiler' | 'runtime' | 'unassigned' | 'upstream';

export interface CompilerCheckTriageModule {
  readonly name: string;
  readonly packageName: string;
  readonly source: string;
}

export interface CompilerCheckTriageOccurrence {
  readonly message: string;
}

export interface CompilerCheckTriageFindingInput {
  readonly code: string;
  readonly identity: string;
  readonly module: CompilerCheckTriageModule;
  readonly occurrences: readonly CompilerCheckTriageOccurrence[];
  readonly policyClass:
    | 'compiler-defect'
    | 'compiler-restriction'
    | 'source-portability'
    | 'target-runtime'
    | 'unclassified';
  readonly rule?: string | undefined;
  readonly stage: 'emission' | 'initialization' | 'lowering' | 'source';
}

export interface CompilerCheckTriageCascadeInput {
  readonly directFindingIdentities: readonly string[];
  readonly module: CompilerCheckTriageModule;
}

export interface CompilerCheckTriageReportInput {
  readonly backend: string;
  readonly cascades: readonly CompilerCheckTriageCascadeInput[];
  readonly directFindings: readonly CompilerCheckTriageFindingInput[];
  readonly provenance: Readonly<{
    readonly compiler: Readonly<{ readonly name: string; readonly revision: string }>;
    readonly target: Readonly<{ readonly name: string; readonly revision: string }>;
    readonly upstream: Readonly<{ readonly name: string; readonly revision: string }>;
  }>;
  readonly schema: 'flight-compiler-check-report/1';
}

export interface CompilerCheckTriageFinding {
  readonly cascadeFanOut: number;
  readonly cascadeModules: readonly string[];
  readonly exclusivelyBlockedModules: readonly string[];
  readonly identity: string;
  readonly module: string;
  readonly owner: CompilerCheckTriageOwner;
  readonly policyClass: CompilerCheckTriageFindingInput['policyClass'];
  readonly rule: string;
  readonly stage: CompilerCheckTriageFindingInput['stage'];
}

export interface CompilerCheckMissingBindingCandidate {
  readonly bindings: readonly string[];
  readonly cascadeFanOut: number;
  readonly cascadeModules: readonly string[];
  readonly cascadeModulesUnlocked: readonly string[];
  readonly directFindingIdentities: readonly string[];
  readonly directModules: readonly string[];
  readonly directModulesUnlocked: readonly string[];
  readonly modulesUnlocked: readonly string[];
  readonly owner: 'runtime';
}

export interface CompilerCheckTriageAnalysis {
  readonly backend: string;
  readonly cascades: number;
  readonly directFindings: number;
  readonly missingBindingCandidates: readonly CompilerCheckMissingBindingCandidate[];
  readonly provenance: CompilerCheckTriageReportInput['provenance'];
  readonly rankedFindings: readonly CompilerCheckTriageFinding[];
  readonly schema: 'flight-compiler-check-triage/1';
}

interface MissingBindingGroup {
  readonly bindings: readonly string[];
  readonly findings: CompilerCheckTriageFindingInput[];
}

const missingBindingRule = 'cpp-runtime-external-symbol-binding-incomplete';
const missingBindingPattern = /runtime external symbol binding plan is incomplete \(missing: (?<bindings>[^)]+)\)/u;

export function analyzeCompilerCheckTriage(
  report: Readonly<CompilerCheckTriageReportInput>,
): CompilerCheckTriageAnalysis {
  const cascadesByFinding = new Map<string, CompilerCheckTriageCascadeInput[]>();
  for (const cascade of report.cascades) {
    for (const identity of new Set(cascade.directFindingIdentities)) {
      cascadesByFinding.set(identity, [...(cascadesByFinding.get(identity) ?? []), cascade]);
    }
  }

  const rankedFindings = report.directFindings
    .map((finding): CompilerCheckTriageFinding => {
      const cascades = cascadesByFinding.get(finding.identity) ?? [];
      return {
        cascadeFanOut: new Set(cascades.map((cascade) => getCompilerCheckTriageModuleKey(cascade.module))).size,
        cascadeModules: sortModules(cascades.map((cascade) => cascade.module)),
        exclusivelyBlockedModules: sortModules(
          cascades
            .filter(
              (cascade) =>
                cascade.directFindingIdentities.length === 1 && cascade.directFindingIdentities[0] === finding.identity,
            )
            .map((cascade) => cascade.module),
        ),
        identity: finding.identity,
        module: getCompilerCheckTriageModuleKey(finding.module),
        owner: getCompilerCheckTriageOwner(finding.policyClass),
        policyClass: finding.policyClass,
        rule: finding.rule ?? finding.code,
        stage: finding.stage,
      };
    })
    .sort(
      (left, right) =>
        right.cascadeFanOut - left.cascadeFanOut ||
        right.exclusivelyBlockedModules.length - left.exclusivelyBlockedModules.length ||
        compareCompilerCheckTriageText(left.identity, right.identity),
    );

  return {
    backend: report.backend,
    cascades: report.cascades.length,
    directFindings: report.directFindings.length,
    missingBindingCandidates: collectMissingBindingCandidates(report, cascadesByFinding),
    provenance: report.provenance,
    rankedFindings,
    schema: 'flight-compiler-check-triage/1',
  };
}

export function readCompilerCheckTriageReport(value: unknown): CompilerCheckTriageReportInput {
  if (!isRecord(value)) throw new TypeError('Compiler check triage requires a JSON object');
  const candidate = value.schema === 'flight-compiler-check-run/1' ? value.report : value;
  if (
    !isRecord(candidate) ||
    candidate.schema !== 'flight-compiler-check-report/1' ||
    typeof candidate.backend !== 'string' ||
    !Array.isArray(candidate.cascades) ||
    !Array.isArray(candidate.directFindings) ||
    !isRecord(candidate.provenance)
  ) {
    throw new TypeError('Compiler check triage requires flight-compiler-check-report/1 or check-run/1 JSON');
  }
  return candidate as unknown as CompilerCheckTriageReportInput;
}

export function getCompilerCheckTriageOwner(
  policyClass: CompilerCheckTriageFindingInput['policyClass'],
): CompilerCheckTriageOwner {
  if (policyClass === 'target-runtime') return 'runtime';
  if (policyClass === 'source-portability') return 'upstream';
  if (policyClass === 'unclassified') return 'unassigned';
  return 'compiler';
}

export function getCompilerCheckMissingBindings(
  finding: Readonly<CompilerCheckTriageFindingInput>,
): readonly string[] | undefined {
  if (finding.rule !== missingBindingRule || finding.occurrences.length === 0) return undefined;
  const bindings = new Set<string>();
  for (const occurrence of finding.occurrences) {
    const match = missingBindingPattern.exec(occurrence.message);
    if (!match?.groups?.bindings) return undefined;
    for (const binding of match.groups.bindings.split(',').map((value) => value.trim())) {
      if (binding.length > 0) bindings.add(binding);
    }
  }
  return bindings.size === 0 ? undefined : [...bindings].sort(compareCompilerCheckTriageText);
}

export function getCompilerCheckTriageModuleKey(module: Readonly<CompilerCheckTriageModule>): string {
  return `${module.packageName}/${module.source}#${module.name}`;
}

function collectMissingBindingCandidates(
  report: Readonly<CompilerCheckTriageReportInput>,
  cascadesByFinding: ReadonlyMap<string, readonly CompilerCheckTriageCascadeInput[]>,
): CompilerCheckMissingBindingCandidate[] {
  const groups = new Map<string, MissingBindingGroup>();
  for (const finding of report.directFindings) {
    const bindings = getCompilerCheckMissingBindings(finding);
    if (!bindings) continue;
    const key = JSON.stringify(bindings);
    const group = groups.get(key) ?? { bindings, findings: [] };
    group.findings.push(finding);
    groups.set(key, group);
  }

  const blockingFindingsByModule = new Map<string, Set<string>>();
  for (const finding of report.directFindings) {
    if (finding.stage === 'source') continue;
    const module = getCompilerCheckTriageModuleKey(finding.module);
    const identities = blockingFindingsByModule.get(module) ?? new Set<string>();
    identities.add(finding.identity);
    blockingFindingsByModule.set(module, identities);
  }

  return [...groups.values()]
    .map((group): CompilerCheckMissingBindingCandidate => {
      const identities = new Set(group.findings.map((finding) => finding.identity));
      const cascadeModules = new Map<string, CompilerCheckTriageModule>();
      for (const identity of identities) {
        for (const cascade of cascadesByFinding.get(identity) ?? []) {
          cascadeModules.set(getCompilerCheckTriageModuleKey(cascade.module), cascade.module);
        }
      }
      const directModules = new Map(
        group.findings.map((finding) => [getCompilerCheckTriageModuleKey(finding.module), finding.module] as const),
      );
      const directModulesUnlocked = [...directModules]
        .filter(([, module]) =>
          [...(blockingFindingsByModule.get(getCompilerCheckTriageModuleKey(module)) ?? [])].every((identity) =>
            identities.has(identity),
          ),
        )
        .map(([, module]) => module);
      const cascadeModulesUnlocked = report.cascades
        .filter(
          (cascade) =>
            cascade.directFindingIdentities.length > 0 &&
            cascade.directFindingIdentities.every((identity) => identities.has(identity)),
        )
        .map((cascade) => cascade.module);
      return {
        bindings: group.bindings,
        cascadeFanOut: cascadeModules.size,
        cascadeModules: sortModules([...cascadeModules.values()]),
        cascadeModulesUnlocked: sortModules(cascadeModulesUnlocked),
        directFindingIdentities: [...identities].sort(compareCompilerCheckTriageText),
        directModules: sortModules([...directModules.values()]),
        directModulesUnlocked: sortModules(directModulesUnlocked),
        modulesUnlocked: sortModules([...directModulesUnlocked, ...cascadeModulesUnlocked]),
        owner: 'runtime',
      };
    })
    .sort(
      (left, right) =>
        right.modulesUnlocked.length - left.modulesUnlocked.length ||
        right.cascadeFanOut - left.cascadeFanOut ||
        right.directFindingIdentities.length - left.directFindingIdentities.length ||
        compareCompilerCheckTriageText(left.bindings.join(', '), right.bindings.join(', ')),
    );
}

function sortModules(modules: readonly Readonly<CompilerCheckTriageModule>[]): string[] {
  return [...new Set(modules.map(getCompilerCheckTriageModuleKey))].sort(compareCompilerCheckTriageText);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function compareCompilerCheckTriageText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
