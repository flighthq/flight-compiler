import { parse } from 'yaml';

import { collectWorkflowJobs, getStepRun } from './releaseWorkflow.js';

// C++ CI jobs must exercise only the C++ target, in both emitted-source lanes. Each command
// deliberately defaults to every installed target for local verification, so omitting a target here
// makes runner image contents decide whether a nominal C++ job also builds Haxe or Rust.

export function collectCiWorkflowIssues(name: string, contents: string): readonly string[] {
  const document = parseWorkflow(contents);
  if (document === undefined) return [`${name}: the workflow is not readable YAML`];

  const issues: string[] = [];
  const jobs = new Map(collectWorkflowJobs(document).map((job) => [job.name, job]));
  for (const jobName of cppTargetJobs) {
    const job = jobs.get(jobName);
    if (job === undefined) {
      issues.push(`${name}: required C++ job ${jobName} is missing`);
      continue;
    }
    for (const lane of cppTargetLanes) {
      const steps = job.steps.filter((step) => lane.pattern.test(getStepRun(step)));
      if (steps.length !== 1) {
        issues.push(`${name}: C++ job ${jobName} has ${String(steps.length)} ${lane.label} steps, expected 1`);
        continue;
      }
      const targets = collectTargets(getStepRun(steps[0]!));
      if (targets.length !== 1 || targets[0] !== 'cpp') {
        issues.push(
          `${name}: C++ job ${jobName} selects ${targets.length === 0 ? `all installed ${lane.label} targets` : targets.join(', ')}, expected exactly cpp`,
        );
      }
    }
  }
  return issues;
}

function collectTargets(command: string): readonly string[] {
  return [...command.matchAll(targetPattern)].map((match) => match[1]!);
}

function parseWorkflow(contents: string): Readonly<Record<string, unknown>> | undefined {
  try {
    const value: unknown = parse(contents);
    return value !== null && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

const cppTargetJobs = ['cpp-conformance', 'cpp-generated-corpus'] as const;
// One entry per emitted-source lane a C++ job runs: the compile check builds the emitted headers, the
// oracle builds and runs them. Both default to every installed target, so both have to be named.
const cppTargetLanes = [
  { label: 'compile', pattern: /\bnpm run compile:check(?:\s|$)/u },
  { label: 'oracle', pattern: /\bnpm run oracle:check(?:\s|$)/u },
] as const;
const targetPattern = /(?:^|\s)--target(?:=|\s+)([^\s]+)/gu;
