import { parse } from 'yaml';

import { collectWorkflowJobs, getStepRun } from './releaseWorkflow.js';

// C++ CI jobs must exercise only the C++ oracle. The oracle command deliberately defaults to every
// installed target for local verification, so omitting a target here makes runner image contents decide
// whether a nominal C++ job also runs Haxe or Rust.

export function collectCiWorkflowIssues(name: string, contents: string): readonly string[] {
  const document = parseWorkflow(contents);
  if (document === undefined) return [`${name}: the workflow is not readable YAML`];

  const issues: string[] = [];
  const jobs = new Map(collectWorkflowJobs(document).map((job) => [job.name, job]));
  for (const jobName of cppOracleJobs) {
    const job = jobs.get(jobName);
    if (job === undefined) {
      issues.push(`${name}: required C++ oracle job ${jobName} is missing`);
      continue;
    }
    const oracleSteps = job.steps.filter((step) => oracleCommandPattern.test(getStepRun(step)));
    if (oracleSteps.length !== 1) {
      issues.push(`${name}: C++ job ${jobName} has ${String(oracleSteps.length)} oracle steps, expected 1`);
      continue;
    }
    const targets = collectOracleTargets(getStepRun(oracleSteps[0]!));
    if (targets.length !== 1 || targets[0] !== 'cpp') {
      issues.push(
        `${name}: C++ job ${jobName} selects ${targets.length === 0 ? 'all installed oracle targets' : targets.join(', ')}, expected exactly cpp`,
      );
    }
  }
  return issues;
}

function collectOracleTargets(command: string): readonly string[] {
  return [...command.matchAll(oracleTargetPattern)].map((match) => match[1]!);
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

const cppOracleJobs = ['cpp-conformance', 'cpp-generated-corpus'] as const;
const oracleCommandPattern = /\bnpm run oracle:check(?:\s|$)/u;
const oracleTargetPattern = /(?:^|\s)--target(?:=|\s+)([^\s]+)/gu;
