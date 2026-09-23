import { compareTextCodeUnits, normalizePathPortable } from '../../compiler-canonical-form/src/index.js';
import type {
  CompilerModuleIdentity,
  CompilerPackageCheckBaseline,
  CompilerPackageCheckCascade,
  CompilerPackageCheckClassificationTable,
  CompilerPackageCheckComparison,
  CompilerPackageCheckFinding,
  CompilerPackageCheckFindingCode,
  CompilerPackageCheckFindingOccurrence,
  CompilerPackageCheckModuleTotals,
  CompilerPackageCheckOptions,
  CompilerPackageCheckPackageSummary,
  CompilerPackageCheckPolicy,
  CompilerPackageCheckPolicyClass,
  CompilerPackageCheckPolicyResult,
  CompilerPackageCheckProvenance,
  CompilerPackageCheckReport,
  CompilerPackageCompilationModuleReport,
  CompilerPackageCompilationRefusal,
  CompilerPackageCompilationReport,
} from '../../compiler-types/src/index.js';

export function compareCompilerPackageCheckBaseline(
  report: Readonly<CompilerPackageCheckReport>,
  baseline: Readonly<CompilerPackageCheckBaseline>,
): CompilerPackageCheckComparison {
  if (report.schema !== 'flight-compiler-check-report/1')
    throw new TypeError(`Unsupported check report ${report.schema}`);
  if (baseline.schema !== 'flight-compiler-check-baseline/1') {
    throw new TypeError(`Unsupported check baseline ${baseline.schema}`);
  }
  const baselineIdentities = new Set(baseline.findingIdentities);
  const currentIdentities = new Set(report.directFindings.map((finding) => finding.identity));
  const introduced = report.directFindings
    .filter((finding) => !baselineIdentities.has(finding.identity))
    .map(cloneFinding)
    .sort(compareFindings);
  const unchanged = report.directFindings
    .filter((finding) => baselineIdentities.has(finding.identity))
    .map(cloneFinding)
    .sort(compareFindings);
  const resolvedFindingIdentities = [...baselineIdentities]
    .filter((identity) => !currentIdentities.has(identity))
    .sort(compareTextCodeUnits);
  return {
    introduced,
    resolvedFindingIdentities,
    schema: 'flight-compiler-check-comparison/1',
    unchanged,
  };
}

export function createCompilerPackageCheckBaseline(
  report: Readonly<CompilerPackageCheckReport>,
): CompilerPackageCheckBaseline {
  if (report.schema !== 'flight-compiler-check-report/1')
    throw new TypeError(`Unsupported check report ${report.schema}`);
  return {
    findingIdentities: [...new Set(report.directFindings.map((finding) => finding.identity))].sort(
      compareTextCodeUnits,
    ),
    schema: 'flight-compiler-check-baseline/1',
  };
}

export function createCompilerPackageCheckPolicyResult(
  comparison: Readonly<CompilerPackageCheckComparison>,
  policy: Readonly<CompilerPackageCheckPolicy>,
): CompilerPackageCheckPolicyResult {
  if (comparison.schema !== 'flight-compiler-check-comparison/1') {
    throw new TypeError(`Unsupported check comparison ${comparison.schema}`);
  }
  if (policy.schema !== 'flight-compiler-check-policy/1')
    throw new TypeError(`Unsupported check policy ${policy.schema}`);
  const failOnIntroduced = [...new Set(policy.failOnIntroduced.map(assertPolicyClass))].sort(compareTextCodeUnits);
  const failingFindingIdentities = comparison.introduced
    .filter((finding) => failOnIntroduced.includes(finding.policyClass))
    .map((finding) => finding.identity)
    .sort(compareTextCodeUnits);
  return {
    failingFindingIdentities,
    passed: failingFindingIdentities.length === 0,
    policy: {
      failOnIntroduced,
      id: normalizeText(policy.id),
      schema: 'flight-compiler-check-policy/1',
    },
    schema: 'flight-compiler-check-policy-result/1',
  };
}

export function createCompilerPackageCheckPolicyStrict(): CompilerPackageCheckPolicy {
  return {
    failOnIntroduced: ['compiler-restriction', 'source-portability', 'unclassified'],
    id: 'strict-flight-attribution-v1',
    schema: 'flight-compiler-check-policy/1',
  };
}

export function createCompilerPackageCheckReport(
  compilation: Readonly<CompilerPackageCompilationReport>,
  options: Readonly<CompilerPackageCheckOptions>,
): CompilerPackageCheckReport {
  if (compilation.schema !== 'flight-compiler-package-report/1') {
    throw new TypeError(`Unsupported package compilation report ${compilation.schema}`);
  }
  const classification = createClassificationLookup(options.classification);
  const modules = [...compilation.modules].sort(compareModuleReports);
  const modulesBySubject = new Map<string, Readonly<CompilerPackageCompilationModuleReport>>();
  for (const module of modules) {
    const subject = getModuleSubject(module.module);
    if (modulesBySubject.has(subject)) throw new TypeError(`Duplicate compiler package module ${subject}`);
    modulesBySubject.set(subject, module);
    getModuleDisposition(module);
  }

  const findingBuilders = new Map<
    string,
    {
      finding: Omit<CompilerPackageCheckFinding, 'occurrences'>;
      occurrences: Map<string, CompilerPackageCheckFindingOccurrence>;
    }
  >();
  const directIdentitiesBySubject = new Map<string, string[]>();
  for (const module of modules) {
    if (getModuleDisposition(module) !== 'direct') continue;
    const identities: string[] = [];
    for (const refusal of module.refusals) {
      if (refusal.code === 'dependency-refused') continue;
      const code = refusal.code;
      if (refusal.stage === 'dependency') {
        throw new TypeError(`Direct refusal ${code} for ${getModuleSubject(module.module)} uses dependency stage`);
      }
      const identity = createFindingIdentity(module.module, refusal, code);
      const occurrence = createFindingOccurrence(refusal);
      let builder = findingBuilders.get(identity);
      if (!builder) {
        const rule = refusal.rule === undefined ? undefined : normalizeText(refusal.rule);
        builder = {
          finding: {
            code,
            identity,
            module: cloneModuleIdentity(module.module),
            policyClass: classifyRefusal(refusal, classification),
            ...(rule === undefined ? {} : { rule }),
            stage: refusal.stage,
          },
          occurrences: new Map(),
        };
        findingBuilders.set(identity, builder);
      }
      builder.occurrences.set(createOccurrenceIdentity(occurrence), occurrence);
      identities.push(identity);
    }
    directIdentitiesBySubject.set(getModuleSubject(module.module), [...new Set(identities)].sort(compareTextCodeUnits));
  }

  const directFindings = [...findingBuilders.values()]
    .map(({ finding, occurrences }) => ({
      ...finding,
      occurrences: [...occurrences.values()].sort(compareOccurrences),
    }))
    .sort(compareFindings);
  const cascades = modules
    .filter((module) => getModuleDisposition(module) === 'cascade')
    .map((module) => ({
      directFindingIdentities: resolveCascadeFindingIdentities(
        getModuleSubject(module.module),
        modulesBySubject,
        directIdentitiesBySubject,
        new Set(),
      ),
      module: cloneModuleIdentity(module.module),
    }))
    .sort(compareCascades);
  const packages = createPackageSummaries(compilation, modules, directFindings, cascades);
  const moduleTotals = createModuleTotals(modules);
  return {
    backend: normalizeText(compilation.backend),
    cascades,
    directFindings,
    packages,
    provenance: cloneProvenance(options.provenance),
    schema: 'flight-compiler-check-report/1',
    totals: {
      dependencyCascades: cascades.length,
      directFindings: directFindings.length,
      directOccurrences: directFindings.reduce((total, finding) => total + finding.occurrences.length, 0),
      modules: moduleTotals,
      packages: packages.length,
    },
    typescript: {
      checkerMode: compilation.typescript.checkerMode,
      compilerOptions: { ...compilation.typescript.compilerOptions },
      schema: compilation.typescript.schema,
      typescriptVersion: normalizeText(compilation.typescript.typescriptVersion),
    },
  };
}

export function getCompilerPackageCheckReportJson(report: Readonly<CompilerPackageCheckReport>): string {
  if (report.schema !== 'flight-compiler-check-report/1')
    throw new TypeError(`Unsupported check report ${report.schema}`);
  return `${JSON.stringify(report, undefined, 2)}\n`;
}

export function getCompilerPackageCheckReportText(report: Readonly<CompilerPackageCheckReport>): string {
  if (report.schema !== 'flight-compiler-check-report/1')
    throw new TypeError(`Unsupported check report ${report.schema}`);
  const lines = [
    `Flight compiler check ${report.schema}`,
    `Provenance: compiler=${renderArtifact(report.provenance.compiler)} target=${renderArtifact(report.provenance.target)} upstream=${renderArtifact(report.provenance.upstream)} backend=${report.backend} typescript=${report.typescript.typescriptVersion}`,
    `Modules: ${String(report.totals.modules.total)} total, ${String(report.totals.modules.emitted)} emitted, ${String(report.totals.modules.directlyRefused)} directly refused, ${String(report.totals.modules.dependencyRefused)} dependency refused`,
    `Direct findings: ${String(report.totals.directFindings)} findings, ${String(report.totals.directOccurrences)} occurrences`,
  ];
  const findings = [...report.directFindings].sort(compareFindings);
  for (const policyClass of [...new Set(findings.map((finding) => finding.policyClass))].sort(compareTextCodeUnits)) {
    lines.push(`Policy: ${policyClass}`);
    const policyFindings = findings.filter((finding) => finding.policyClass === policyClass);
    const rules = [...new Set(policyFindings.map(getFindingRuleLabel))].sort(compareTextCodeUnits);
    for (const rule of rules) {
      lines.push(`  ${rule}`);
      const ruleFindings = policyFindings.filter((finding) => getFindingRuleLabel(finding) === rule);
      const packages = [...new Set(ruleFindings.map((finding) => finding.module.packageName))].sort(
        compareTextCodeUnits,
      );
      for (const packageName of packages) {
        lines.push(`    Package: ${packageName}`);
        for (const finding of ruleFindings.filter((value) => value.module.packageName === packageName)) {
          lines.push(
            `      ${finding.module.source}#${finding.module.name} [${finding.stage}/${finding.code}] (${String(finding.occurrences.length)})`,
          );
          for (const occurrence of finding.occurrences) {
            lines.push(`        ${renderOccurrenceLocation(occurrence)}${occurrence.message}`);
          }
        }
      }
    }
  }
  lines.push(`Dependency cascades: ${String(report.cascades.length)}`);
  const cascades = [...report.cascades].sort(compareCascades);
  for (const packageName of [...new Set(cascades.map((cascade) => cascade.module.packageName))].sort(
    compareTextCodeUnits,
  )) {
    lines.push(`  Package: ${packageName}`);
    for (const cascade of cascades.filter((value) => value.module.packageName === packageName)) {
      lines.push(
        `    ${cascade.module.source}#${cascade.module.name} <- ${cascade.directFindingIdentities.join(', ')}`,
      );
    }
  }
  return `${lines.join('\n')}\n`;
}

const policyClasses = new Set<CompilerPackageCheckPolicyClass>([
  'compiler-defect',
  'compiler-restriction',
  'source-portability',
  'target-runtime',
  'unclassified',
]);

const defaultCodeClassifications = new Map<string, CompilerPackageCheckPolicyClass>([
  ['duplicate-emitted-path', 'compiler-defect'],
  ['top-level-await', 'compiler-restriction'],
  ['unsafe-emitted-contents', 'compiler-defect'],
  ['unsafe-emitted-path', 'compiler-defect'],
  ['unsupported-default-expression-order', 'compiler-restriction'],
  ['unsupported-ir', 'compiler-restriction'],
  ['unsupported-typescript', 'compiler-restriction'],
]);

function assertPolicyClass(value: CompilerPackageCheckPolicyClass): CompilerPackageCheckPolicyClass {
  if (!policyClasses.has(value)) throw new TypeError(`Unknown compiler check policy class ${value}`);
  return value;
}

function classifyRefusal(
  refusal: Readonly<CompilerPackageCompilationRefusal>,
  classification: Readonly<{
    codes: ReadonlyMap<string, CompilerPackageCheckPolicyClass>;
    rules: ReadonlyMap<string, CompilerPackageCheckPolicyClass>;
  }>,
): CompilerPackageCheckPolicyClass {
  if (refusal.rule !== undefined) {
    const ruleClassification = classification.rules.get(normalizeText(refusal.rule));
    if (ruleClassification !== undefined) return ruleClassification;
  } else {
    const codeClassification = classification.codes.get(refusal.code);
    if (codeClassification !== undefined) return codeClassification;
  }
  if (refusal.classification !== undefined) return assertPolicyClass(refusal.classification);
  if (refusal.rule !== undefined) return 'unclassified';
  return defaultCodeClassifications.get(refusal.code) ?? 'unclassified';
}

function cloneFinding(finding: Readonly<CompilerPackageCheckFinding>): CompilerPackageCheckFinding {
  return {
    code: finding.code,
    identity: finding.identity,
    module: cloneModuleIdentity(finding.module),
    occurrences: finding.occurrences.map((occurrence) => ({ ...occurrence })),
    policyClass: finding.policyClass,
    ...(finding.rule === undefined ? {} : { rule: finding.rule }),
    stage: finding.stage,
  };
}

function cloneModuleIdentity(module: Readonly<CompilerModuleIdentity>): CompilerModuleIdentity {
  return {
    name: normalizeText(module.name),
    packageName: normalizeText(module.packageName),
    source: normalizePathPortable(module.source).normalize('NFC'),
  };
}

function cloneProvenance(provenance: Readonly<CompilerPackageCheckProvenance>): CompilerPackageCheckProvenance {
  return {
    compiler: { name: normalizeText(provenance.compiler.name), revision: normalizeText(provenance.compiler.revision) },
    target: { name: normalizeText(provenance.target.name), revision: normalizeText(provenance.target.revision) },
    upstream: { name: normalizeText(provenance.upstream.name), revision: normalizeText(provenance.upstream.revision) },
  };
}

function compareCascades(
  left: Readonly<CompilerPackageCheckCascade>,
  right: Readonly<CompilerPackageCheckCascade>,
): number {
  return compareTextCodeUnits(getModuleSubject(left.module), getModuleSubject(right.module));
}

function compareFindings(
  left: Readonly<CompilerPackageCheckFinding>,
  right: Readonly<CompilerPackageCheckFinding>,
): number {
  return compareTextCodeUnits(left.identity, right.identity);
}

function compareModuleReports(
  left: Readonly<CompilerPackageCompilationModuleReport>,
  right: Readonly<CompilerPackageCompilationModuleReport>,
): number {
  return compareTextCodeUnits(getModuleSubject(left.module), getModuleSubject(right.module));
}

function compareOccurrences(
  left: Readonly<CompilerPackageCheckFindingOccurrence>,
  right: Readonly<CompilerPackageCheckFindingOccurrence>,
): number {
  return compareTextCodeUnits(createOccurrenceIdentity(left), createOccurrenceIdentity(right));
}

function createClassificationLookup(classification: Readonly<CompilerPackageCheckClassificationTable> | undefined): {
  codes: ReadonlyMap<string, CompilerPackageCheckPolicyClass>;
  rules: ReadonlyMap<string, CompilerPackageCheckPolicyClass>;
} {
  if (classification && classification.schema !== 'flight-compiler-check-classification/1') {
    throw new TypeError(`Unsupported check classification ${classification.schema}`);
  }
  return {
    codes: createClassificationMap(classification?.codes),
    rules: createClassificationMap(classification?.rules),
  };
}

function createClassificationMap(
  values: Readonly<Record<string, CompilerPackageCheckPolicyClass>> | undefined,
): ReadonlyMap<string, CompilerPackageCheckPolicyClass> {
  const normalized = new Map<string, CompilerPackageCheckPolicyClass>();
  for (const [inputKey, inputValue] of Object.entries(values ?? {}).sort(([left], [right]) =>
    compareTextCodeUnits(left, right),
  )) {
    const key = normalizeText(inputKey);
    const value = assertPolicyClass(inputValue);
    const existing = normalized.get(key);
    if (existing !== undefined && existing !== value) throw new TypeError(`Conflicting classifications for ${key}`);
    normalized.set(key, value);
  }
  return normalized;
}

function createFindingIdentity(
  module: Readonly<CompilerModuleIdentity>,
  refusal: Readonly<CompilerPackageCompilationRefusal>,
  code: CompilerPackageCheckFindingCode,
): string {
  const normalizedModule = cloneModuleIdentity(module);
  return `flight-compiler-check-finding/1:${JSON.stringify([
    normalizedModule.packageName,
    normalizedModule.source,
    normalizedModule.name,
    refusal.stage,
    code,
    refusal.rule === undefined ? null : normalizeText(refusal.rule),
  ])}`;
}

function createFindingOccurrence(
  refusal: Readonly<CompilerPackageCompilationRefusal>,
): CompilerPackageCheckFindingOccurrence {
  return {
    ...(refusal.column === undefined ? {} : { column: refusal.column }),
    ...(refusal.line === undefined ? {} : { line: refusal.line }),
    message: normalizeText(refusal.message),
  };
}

function createModuleTotals(
  modules: readonly Readonly<CompilerPackageCompilationModuleReport>[],
): CompilerPackageCheckModuleTotals {
  const dispositions = modules.map(getModuleDisposition);
  return {
    dependencyRefused: dispositions.filter((value) => value === 'cascade').length,
    directlyRefused: dispositions.filter((value) => value === 'direct').length,
    emitted: dispositions.filter((value) => value === 'emitted').length,
    total: modules.length,
  };
}

function createOccurrenceIdentity(occurrence: Readonly<CompilerPackageCheckFindingOccurrence>): string {
  return JSON.stringify([occurrence.message, occurrence.line ?? null, occurrence.column ?? null]);
}

function createPackageSummaries(
  compilation: Readonly<CompilerPackageCompilationReport>,
  modules: readonly Readonly<CompilerPackageCompilationModuleReport>[],
  directFindings: readonly Readonly<CompilerPackageCheckFinding>[],
  cascades: readonly Readonly<CompilerPackageCheckCascade>[],
): CompilerPackageCheckPackageSummary[] {
  const packageNames = new Set(compilation.packages.map((value) => normalizeText(value.name)));
  for (const module of modules) packageNames.add(normalizeText(module.module.packageName));
  return [...packageNames].sort(compareTextCodeUnits).map((name) => {
    const packageModules = modules.filter((module) => normalizeText(module.module.packageName) === name);
    const packageFindings = directFindings.filter((finding) => finding.module.packageName === name);
    const findingsByPolicy = createPolicyCounts();
    for (const finding of packageFindings) findingsByPolicy[finding.policyClass] += 1;
    return {
      dependencyCascades: cascades.filter((cascade) => cascade.module.packageName === name).length,
      directFindings: packageFindings.length,
      directOccurrences: packageFindings.reduce((total, finding) => total + finding.occurrences.length, 0),
      findingsByPolicy,
      modules: createModuleTotals(packageModules),
      name,
    };
  });
}

function createPolicyCounts(): Record<CompilerPackageCheckPolicyClass, number> {
  return {
    'compiler-defect': 0,
    'compiler-restriction': 0,
    'source-portability': 0,
    'target-runtime': 0,
    unclassified: 0,
  };
}

function getDependencySubjects(module: Readonly<CompilerPackageCompilationModuleReport>): string[] {
  const dependencies = module.refusals.flatMap((refusal) => {
    if (refusal.code !== 'dependency-refused') return [];
    if (refusal.stage !== 'dependency') {
      throw new TypeError(`Dependency refusal for ${getModuleSubject(module.module)} uses ${refusal.stage} stage`);
    }
    if (!refusal.refusedDependencies || refusal.refusedDependencies.length === 0) {
      throw new TypeError(`Dependency refusal for ${getModuleSubject(module.module)} has no refused dependencies`);
    }
    return refusal.refusedDependencies.map((dependency) => normalizePathPortable(dependency).normalize('NFC'));
  });
  return [...new Set(dependencies)].sort(compareTextCodeUnits);
}

function getFindingRuleLabel(finding: Readonly<CompilerPackageCheckFinding>): string {
  return finding.rule === undefined ? `Code: ${finding.code}` : `Rule: ${finding.rule}`;
}

function getModuleDisposition(
  module: Readonly<CompilerPackageCompilationModuleReport>,
): 'cascade' | 'direct' | 'emitted' {
  if (module.status === 'emitted') {
    if (module.refusals.length > 0)
      throw new TypeError(`Emitted module ${getModuleSubject(module.module)} has refusals`);
    return 'emitted';
  }
  if (module.refusals.length === 0)
    throw new TypeError(`Refused module ${getModuleSubject(module.module)} has no refusals`);
  const directCount = module.refusals.filter((refusal) => refusal.code !== 'dependency-refused').length;
  const dependencyCount = module.refusals.length - directCount;
  if (directCount > 0 && dependencyCount > 0) {
    throw new TypeError(`Refused module ${getModuleSubject(module.module)} mixes direct and dependency refusals`);
  }
  return directCount > 0 ? 'direct' : 'cascade';
}

function getModuleSubject(module: Readonly<CompilerModuleIdentity>): string {
  const normalized = cloneModuleIdentity(module);
  return `${normalized.packageName}/${normalized.source}`;
}

function normalizeText(value: string): string {
  return value.normalize('NFC');
}

function renderArtifact(artifact: Readonly<{ name: string; revision: string }>): string {
  return `${artifact.name}@${artifact.revision}`;
}

function renderOccurrenceLocation(occurrence: Readonly<CompilerPackageCheckFindingOccurrence>): string {
  if (occurrence.line === undefined) return '';
  return `${String(occurrence.line)}${occurrence.column === undefined ? '' : `:${String(occurrence.column)}`}: `;
}

function resolveCascadeFindingIdentities(
  subject: string,
  modulesBySubject: ReadonlyMap<string, Readonly<CompilerPackageCompilationModuleReport>>,
  directIdentitiesBySubject: ReadonlyMap<string, readonly string[]>,
  visiting: ReadonlySet<string>,
): string[] {
  if (visiting.has(subject)) throw new TypeError(`Dependency refusal cycle at ${subject}`);
  const module = modulesBySubject.get(subject);
  if (!module) throw new TypeError(`Dependency refusal references unknown module ${subject}`);
  const direct = directIdentitiesBySubject.get(subject);
  if (direct) return [...direct];
  if (getModuleDisposition(module) !== 'cascade') {
    throw new TypeError(`Dependency refusal references emitted module ${subject}`);
  }
  const nextVisiting = new Set(visiting);
  nextVisiting.add(subject);
  const identities = getDependencySubjects(module).flatMap((dependency) =>
    resolveCascadeFindingIdentities(dependency, modulesBySubject, directIdentitiesBySubject, nextVisiting),
  );
  if (identities.length === 0) throw new TypeError(`Dependency refusal for ${subject} resolves to no direct findings`);
  return [...new Set(identities)].sort(compareTextCodeUnits);
}
