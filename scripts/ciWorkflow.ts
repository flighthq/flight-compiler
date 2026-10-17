import { parse } from 'yaml';

import { collectWorkflowJobs, getStepRun } from './releaseWorkflow.js';

// Target-specific CI jobs must exercise only their named target in both emitted-source lanes. Each
// command deliberately defaults to every installed target for local verification, so omitting a
// target here makes runner image contents decide what a nominally isolated job validates.

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
  const rustJob = jobs.get(rustTargetJob);
  if (rustJob === undefined) {
    issues.push(`${name}: required Rust job ${rustTargetJob} is missing`);
    return issues;
  }
  const environment = asRecord(rustJob.job.env);
  if (String(environment?.FLIGHT_RUST_REQUIRE_RUSTC ?? '') !== '1') {
    issues.push(`${name}: Rust job ${rustTargetJob} does not require rustc`);
  }
  const toolchain = environment?.RUSTUP_TOOLCHAIN;
  if (typeof toolchain !== 'string' || !rustToolchainVersionPattern.test(toolchain)) {
    issues.push(`${name}: Rust job ${rustTargetJob} does not pin an exact Rust toolchain`);
  }
  const installSteps = rustJob.steps.filter((step) => rustToolchainInstallPattern.test(getStepRun(step)));
  if (installSteps.length !== 1) {
    issues.push(
      `${name}: Rust job ${rustTargetJob} has ${String(installSteps.length)} pinned toolchain install steps, expected 1`,
    );
  }
  const maturitySteps = rustJob.steps.filter((step) => rustMaturityCheckpointPattern.test(getStepRun(step)));
  if (maturitySteps.length !== 1) {
    issues.push(
      `${name}: Rust job ${rustTargetJob} has ${String(maturitySteps.length)} maturity checkpoint steps, expected 1`,
    );
  } else {
    const maturityIndex = rustJob.steps.indexOf(maturitySteps[0]!);
    if (installSteps.length === 1 && maturityIndex < rustJob.steps.indexOf(installSteps[0]!)) {
      issues.push(`${name}: Rust job ${rustTargetJob} runs its maturity checkpoint before installing rustc`);
    }
    const earlierTargetLane = rustTargetLanes.some((lane) =>
      rustJob.steps.some((step, index) => index < maturityIndex && lane.pattern.test(getStepRun(step))),
    );
    if (earlierTargetLane) {
      issues.push(`${name}: Rust job ${rustTargetJob} runs compile or oracle before its maturity checkpoint`);
    }
  }
  for (const lane of rustTargetLanes) {
    const steps = rustJob.steps.filter((step) => lane.pattern.test(getStepRun(step)));
    if (steps.length !== 1) {
      issues.push(`${name}: Rust job ${rustTargetJob} has ${String(steps.length)} ${lane.label} steps, expected 1`);
      continue;
    }
    const targets = collectTargets(getStepRun(steps[0]!));
    if (targets.length !== 1 || targets[0] !== 'rust') {
      issues.push(
        `${name}: Rust job ${rustTargetJob} selects ${targets.length === 0 ? `all installed ${lane.label} targets` : targets.join(', ')}, expected exactly rust`,
      );
    }
  }
  return issues;
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
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
const rustTargetJob = 'rust-generated-corpus';
const rustTargetLanes = cppTargetLanes;
const rustMaturityCheckpointPattern = /\bnpm run rust:maturity:checkpoint(?:\s|$)/u;
const rustToolchainInstallPattern = /\brustup toolchain install\s+["']?\$RUSTUP_TOOLCHAIN["']?(?:\s|$)/u;
const rustToolchainVersionPattern = /^\d+\.\d+\.\d+$/u;
const targetPattern = /(?:^|\s)--target(?:=|\s+)([^\s]+)/gu;
