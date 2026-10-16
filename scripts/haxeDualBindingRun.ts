import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import type { HaxeDualBindingGateFailure, HaxeDualBindingGateLaneReport } from './haxeDualBindingGate.js';
import { evaluateHaxeDualBindingGates } from './haxeDualBindingGate.js';
import type { HaxeDualBindingCppLocatorOptions, HaxeDualBindingJsLocatorOptions } from './haxeDualBindingLocator.js';
import {
  createHaxeDualBindingCppSymbolLocator,
  createHaxeDualBindingJavaScriptExportLocator,
} from './haxeDualBindingLocator.js';
import type { HaxeDualBindingPlan, HaxeDualBindingPlanParseFailure } from './haxeDualBindingPlan.js';
import { parseHaxeDualBindingPlanArtifact } from './haxeDualBindingPlan.js';

// The runner a person or a checkpoint actually invokes: a directory of serialized
// `flight-haxe-dual-binding-plan/1` artifacts in, one deterministic report out.
//
// It is deliberately a directory rather than a plan: the fold after the producer lanes land has to run
// this over whatever they wrote without knowing which packages produced them, and a plan that fails to
// parse has to appear in the same report as one that parsed and failed a gate. The two existence
// providers are built once for the whole run, so a module named by five plans is imported once.
export interface HaxeDualBindingRunFailure {
  readonly artifact: string;
  readonly detail: string;
  readonly rule: string;
  readonly subject: string;
}

export interface HaxeDualBindingRunLane {
  readonly artifact: string;
  readonly kind: HaxeDualBindingGateLaneReport['kind'];
  readonly skipped: readonly string[];
  readonly verified: HaxeDualBindingGateLaneReport['verified'];
}

export interface HaxeDualBindingRunOptions {
  readonly artifactDirectory: string;
  readonly cpp?: Readonly<HaxeDualBindingCppLocatorOptions>;
  readonly js?: Readonly<HaxeDualBindingJsLocatorOptions>;
}

export interface HaxeDualBindingRunReport {
  readonly artifacts: readonly string[];
  readonly failures: readonly HaxeDualBindingRunFailure[];
  readonly lanes: readonly HaxeDualBindingRunLane[];
}

export interface HaxeDualBindingRunSummary {
  readonly callables: number;
  readonly failures: number;
  readonly types: number;
  readonly unchecked: number;
}

export async function runHaxeDualBindingGateChecks(
  options: Readonly<HaxeDualBindingRunOptions>,
): Promise<HaxeDualBindingRunReport> {
  const collected = collectHaxeDualBindingArtifactFiles(options.artifactDirectory);
  if ('detail' in collected) {
    return {
      artifacts: [],
      failures: [
        {
          artifact: options.artifactDirectory,
          detail: collected.detail,
          rule: 'haxe-dual-binding-artifact-directory-unreadable',
          subject: options.artifactDirectory,
        },
      ],
      lanes: [],
    };
  }
  const files = collected;
  const parsed: { readonly file: string; readonly plan?: Readonly<HaxeDualBindingPlan> }[] = [];
  const failures: HaxeDualBindingRunFailure[] = [];
  for (const file of files) {
    const read = readHaxeDualBindingArtifact(options.artifactDirectory, file);
    if (typeof read !== 'string') {
      failures.push({
        artifact: file,
        detail: read.detail,
        rule: 'haxe-dual-binding-artifact-unreadable',
        subject: file,
      });
      continue;
    }
    const document = parseHaxeDualBindingArtifactJson(read);
    if ('detail' in document) {
      failures.push({
        artifact: file,
        detail: document.detail,
        rule: 'haxe-dual-binding-artifact-not-json',
        subject: file,
      });
      continue;
    }
    const result = parseHaxeDualBindingPlanArtifact(document.value);
    if (result.kind === 'haxe-dual-binding-plan-parsed') {
      parsed.push({ file, plan: result.plan });
      continue;
    }
    failures.push(describeHaxeDualBindingPlanParseFailureForRun(file, result));
  }

  const specifiers = parsed.flatMap((entry) =>
    (entry.plan?.bindings ?? []).flatMap((binding) =>
      binding.javascript.availability === 'available' ? [binding.javascript.locator.specifier] : [],
    ),
  );
  const resolveJavaScriptExport = await createHaxeDualBindingJavaScriptExportLocator(specifiers, options.js ?? {});
  const resolveCppSymbol = createHaxeDualBindingCppSymbolLocator(options.cpp ?? { includeDirectories: [] });

  const lanes: HaxeDualBindingRunLane[] = [];
  for (const entry of parsed) {
    if (!entry.plan) continue;
    const report = evaluateHaxeDualBindingGates(entry.plan, { resolveCppSymbol, resolveJavaScriptExport });
    failures.push(...report.failures.map((failure) => describeHaxeDualBindingGateFailureForRun(entry.file, failure)));
    lanes.push(
      ...report.lanes.map((lane) => ({
        artifact: entry.file,
        kind: lane.kind,
        skipped: lane.skipped,
        verified: lane.verified,
      })),
    );
  }

  return {
    artifacts: files,
    failures: sortHaxeDualBindingRunFailures(failures),
    lanes: lanes.sort((left, right) =>
      left.artifact === right.artifact
        ? compareHaxeDualBindingRunText(left.kind, right.kind)
        : compareHaxeDualBindingRunText(left.artifact, right.artifact),
    ),
  };
}

export function getHaxeDualBindingRunSummary(report: Readonly<HaxeDualBindingRunReport>): HaxeDualBindingRunSummary {
  return {
    callables: report.lanes.reduce((total, lane) => total + lane.verified.callables, 0),
    failures: report.failures.length,
    types: report.lanes.reduce((total, lane) => total + lane.verified.types, 0),
    unchecked: report.lanes.reduce((total, lane) => total + lane.skipped.length, 0),
  };
}

export function formatHaxeDualBindingGateRunReport(report: Readonly<HaxeDualBindingRunReport>): string {
  const summary = getHaxeDualBindingRunSummary(report);
  const lines = [
    `Haxe dual-binding gates: ${String(report.artifacts.length)} artifact(s), ${String(summary.failures)} failure(s), ${String(summary.types)} type(s) and ${String(summary.callables)} callable(s) verified, ${String(summary.unchecked)} selection(s) unchecked.`,
  ];
  for (const failure of report.failures) {
    lines.push(`  ${failure.artifact}: ${failure.rule} ${failure.subject}: ${failure.detail}`);
  }
  for (const lane of report.lanes) {
    lines.push(
      `  ${lane.artifact} ${lane.kind}: ${String(lane.verified.types)} type(s), ${String(lane.verified.callables)} callable(s), ${String(lane.skipped.length)} unchecked`,
    );
    for (const skipped of lane.skipped) lines.push(`    unchecked: ${skipped}`);
  }
  return `${lines.join('\n')}\n`;
}

function collectHaxeDualBindingArtifactFiles(directory: string): readonly string[] | Readonly<{ detail: string }> {
  try {
    return readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
      .map((entry) => entry.name)
      .sort(compareHaxeDualBindingRunText);
  } catch (error) {
    return { detail: error instanceof Error ? error.message : String(error) };
  }
}

function compareHaxeDualBindingRunText(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function parseHaxeDualBindingArtifactJson(contents: string): { readonly value: unknown } | { readonly detail: string } {
  try {
    return { value: JSON.parse(contents) as unknown };
  } catch (error) {
    return { detail: error instanceof Error ? error.message : String(error) };
  }
}

function describeHaxeDualBindingGateFailureForRun(
  artifact: string,
  failure: Readonly<HaxeDualBindingGateFailure>,
): HaxeDualBindingRunFailure {
  return { artifact, detail: failure.detail, rule: failure.rule, subject: failure.subject };
}

function describeHaxeDualBindingPlanParseFailureForRun(
  artifact: string,
  failure: Readonly<HaxeDualBindingPlanParseFailure>,
): HaxeDualBindingRunFailure {
  return { artifact, detail: failure.detail, rule: failure.rule, subject: failure.subject };
}

function readHaxeDualBindingArtifact(directory: string, file: string): string | Readonly<{ detail: string }> {
  try {
    return readFileSync(path.join(directory, file), 'utf8');
  } catch (error) {
    return { detail: error instanceof Error ? error.message : String(error) };
  }
}

function sortHaxeDualBindingRunFailures(
  failures: readonly HaxeDualBindingRunFailure[],
): readonly HaxeDualBindingRunFailure[] {
  return [...failures].sort((left, right) => {
    if (left.artifact !== right.artifact) return compareHaxeDualBindingRunText(left.artifact, right.artifact);
    if (left.subject !== right.subject) return compareHaxeDualBindingRunText(left.subject, right.subject);
    return compareHaxeDualBindingRunText(left.rule, right.rule);
  });
}
