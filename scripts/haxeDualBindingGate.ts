import type {
  HaxeDualBinding,
  HaxeDualBindingBackendKind,
  HaxeDualBindingCppLocator,
  HaxeDualBindingJavaScriptLocator,
  HaxeDualBindingPlan,
  HaxeDualBindingPublicKind,
  HaxeDualBindingRefusal,
} from './haxeDualBindingPlan.js';

// The gates a dual-binding plan must pass before anything downstream may rely on it.
//
// A plan is a claim: this public name exists behind this C++ backing and behind this JavaScript backing,
// with this signature, at these locators. These gates ask the questions the claim cannot answer for
// itself -- does every selected backing present the same public signature, and does the named export or
// symbol actually exist where the plan says it does -- and they refuse to pass by checking nothing.
//
// The existence answers arrive as injected hooks. Loading a JavaScript module needs a loader and locating
// a C++ symbol needs a compiler; both live at the edge, and keeping them out of this module is what lets
// the gate itself stay pure, deterministic, and testable without a toolchain.
export interface HaxeDualBindingGateLaneReport {
  readonly kind: HaxeDualBindingBackendKind;
  // Bindings the lane could not answer for. An unchecked binding is not a pass: it is named in the
  // report, and a lane that verified nothing cannot be non-vacuous.
  readonly skipped: readonly string[];
  readonly verified: Readonly<{ callables: number; types: number }>;
}

export interface HaxeDualBindingGateReport {
  readonly bindings: number;
  readonly failures: readonly HaxeDualBindingGateFailure[];
  readonly kind: 'haxe-dual-binding-gate-report';
  readonly lanes: readonly HaxeDualBindingGateLaneReport[];
}

export type HaxeDualBindingGateFailureRule =
  | 'haxe-dual-binding-gate-backing-refused'
  | 'haxe-dual-binding-gate-locator-absent'
  | 'haxe-dual-binding-gate-signature-parity'
  | 'haxe-dual-binding-gate-vacuous';

export type HaxeDualBindingGateFailure = Readonly<{
  detail: string;
  kind: 'haxe-dual-binding-gate-failure';
  rule: HaxeDualBindingGateFailureRule;
  subject: string;
}>;

export type HaxeDualBindingLocatorEvidence =
  | Readonly<{ detail: string; status: 'absent' }>
  | Readonly<{ status: 'present' }>
  | Readonly<{ detail: string; status: 'skipped' }>;

export interface HaxeDualBindingLocatorHooks {
  readonly resolveCppSymbol: (locator: Readonly<HaxeDualBindingCppLocator>) => HaxeDualBindingLocatorEvidence;
  readonly resolveJavaScriptExport: (
    locator: Readonly<HaxeDualBindingJavaScriptLocator>,
  ) => HaxeDualBindingLocatorEvidence;
}

export function evaluateHaxeDualBindingGates(
  plan: Readonly<HaxeDualBindingPlan>,
  hooks: Readonly<HaxeDualBindingLocatorHooks>,
): HaxeDualBindingGateReport {
  const failures: HaxeDualBindingGateFailure[] = [];
  const counters = new Map<HaxeDualBindingBackendKind, { callables: number; types: number }>([
    ['cpp', { callables: 0, types: 0 }],
    ['javascript', { callables: 0, types: 0 }],
  ]);
  const skipped = new Map<HaxeDualBindingBackendKind, string[]>([
    ['cpp', []],
    ['javascript', []],
  ]);

  for (const binding of plan.bindings) {
    const subject = `binding:${binding.key}`;
    // One public function is one public signature. Runtime values and type-values (notably TypeScript
    // enums) have locators to verify but are not calls, so inventing a function signature for them would
    // make a real dual-backed value impossible to publish.
    if (binding.publicHaxe.kind === 'function' && binding.publicHaxe.signature === undefined) {
      failures.push(
        createHaxeDualBindingGateFailure(
          'haxe-dual-binding-gate-signature-parity',
          subject,
          `${binding.publicHaxe.qualifiedName} is a ${binding.publicHaxe.kind} with no published signature, so its backings cannot be shown to present the same call`,
        ),
      );
    }
    for (const kind of ['cpp', 'javascript'] as const) {
      const backing = kind === 'cpp' ? binding.cpp : binding.javascript;
      if (backing.availability === 'refused') {
        failures.push(describeHaxeDualBindingRefusalForGate(kind, binding, backing.refusal, subject));
        continue;
      }
      const evidence = resolveHaxeDualBindingBackingEvidence(kind, backing, hooks);
      if (evidence.status === 'present') {
        const counter = counters.get(kind)!;
        if (isHaxeDualBindingCallable(binding.publicHaxe.kind)) counter.callables += 1;
        if (isHaxeDualBindingType(binding.publicHaxe.kind)) counter.types += 1;
        continue;
      }
      if (evidence.status === 'skipped') {
        skipped.get(kind)!.push(`${subject} (${describeHaxeDualBindingLocator(kind, binding)})`);
        continue;
      }
      failures.push(
        createHaxeDualBindingGateFailure(
          'haxe-dual-binding-gate-locator-absent',
          subject,
          `${binding.publicHaxe.qualifiedName} is not at ${describeHaxeDualBindingLocator(kind, binding)}: ${evidence.detail}`,
        ),
      );
    }
  }

  const lanes: HaxeDualBindingGateLaneReport[] = (['cpp', 'javascript'] as const).map((kind) => {
    const verified = counters.get(kind)!;
    const laneSkipped = [...skipped.get(kind)!].sort(compareHaxeDualBindingText);
    if (verified.types === 0) {
      failures.push(
        createHaxeDualBindingGateFailure(
          'haxe-dual-binding-gate-vacuous',
          `lane:${kind}`,
          createHaxeDualBindingVacuousDetail(kind, 'type', laneSkipped),
        ),
      );
    }
    if (verified.callables === 0) {
      failures.push(
        createHaxeDualBindingGateFailure(
          'haxe-dual-binding-gate-vacuous',
          `lane:${kind}`,
          createHaxeDualBindingVacuousDetail(kind, 'callable', laneSkipped),
        ),
      );
    }
    return { kind, skipped: laneSkipped, verified: { callables: verified.callables, types: verified.types } };
  });

  return {
    bindings: plan.bindings.length,
    failures: sortHaxeDualBindingGateFailures(failures),
    kind: 'haxe-dual-binding-gate-report',
    lanes,
  };
}

export function sortHaxeDualBindingGateFailures(
  failures: readonly HaxeDualBindingGateFailure[],
): readonly HaxeDualBindingGateFailure[] {
  return [...failures].sort((left, right) =>
    left.subject === right.subject
      ? compareHaxeDualBindingText(left.rule, right.rule)
      : compareHaxeDualBindingText(left.subject, right.subject),
  );
}

function compareHaxeDualBindingText(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function createHaxeDualBindingGateFailure(
  rule: HaxeDualBindingGateFailureRule,
  subject: string,
  detail: string,
): HaxeDualBindingGateFailure {
  return { detail, kind: 'haxe-dual-binding-gate-failure', rule, subject };
}

// A refused backing is a plan fact, not an environment fact: the producer refused to bind this name on
// this target, and the refusal it recorded is the whole reason. The gate quotes it rather than
// summarizing it, so a reader never has to open the producer to learn why.
function describeHaxeDualBindingRefusalForGate(
  kind: HaxeDualBindingBackendKind,
  binding: Readonly<HaxeDualBinding>,
  refusal: Readonly<HaxeDualBindingRefusal>,
  subject: string,
): HaxeDualBindingGateFailure {
  return createHaxeDualBindingGateFailure(
    'haxe-dual-binding-gate-backing-refused',
    subject,
    `${binding.publicHaxe.qualifiedName} has no ${kind} backing: ${refusal.code} refused ${refusal.subject}: ${refusal.message}`,
  );
}

// The sentence a vacuous lane has to print. A lane that verified nothing because its toolchain was absent
// is a different report from one whose plan simply bound nothing, and a reader has to be able to tell
// them apart without re-running anything.
function createHaxeDualBindingVacuousDetail(
  kind: HaxeDualBindingBackendKind,
  missing: 'callable' | 'type',
  skipped: readonly string[],
): string {
  return skipped.length === 0
    ? `the ${kind} backing verified no ${missing}; a gate that checks nothing passes nothing`
    : `the ${kind} backing verified no ${missing}; ${skipped.length} binding${skipped.length === 1 ? ' was' : 's were'} not checked (${skipped.join(', ')})`;
}

function resolveHaxeDualBindingBackingEvidence(
  kind: HaxeDualBindingBackendKind,
  backing: Readonly<HaxeDualBinding['cpp']> | Readonly<HaxeDualBinding['javascript']>,
  hooks: Readonly<HaxeDualBindingLocatorHooks>,
): HaxeDualBindingLocatorEvidence {
  if (backing.availability !== 'available') {
    return { detail: 'the plan declares no usable backing', status: 'absent' };
  }
  return kind === 'cpp'
    ? hooks.resolveCppSymbol(backing.locator as Readonly<HaxeDualBindingCppLocator>)
    : hooks.resolveJavaScriptExport(backing.locator as Readonly<HaxeDualBindingJavaScriptLocator>);
}

function describeHaxeDualBindingLocator(kind: HaxeDualBindingBackendKind, binding: Readonly<HaxeDualBinding>): string {
  if (kind === 'javascript') {
    return binding.javascript.availability === 'available'
      ? `${binding.javascript.locator.specifier}#${binding.javascript.locator.exportedName}`
      : '<refused>';
  }
  return binding.cpp.availability === 'available'
    ? `${binding.cpp.locator.include} ${describeHaxeDualBindingCppSpelling(binding.cpp.locator)}`
    : '<refused>';
}

export function describeHaxeDualBindingCppSpelling(locator: Readonly<HaxeDualBindingCppLocator>): string {
  return locator.namespace.length === 0 ? locator.spelling : `${locator.namespace}::${locator.spelling}`;
}

// A function binding is a call; a value binding is a call or a value; a type and a type-value binding
// publish a type. `type-value` is the producer's name for one public name that is both, so it counts for
// both lanes' non-vacuity rather than for neither.
export function isHaxeDualBindingCallable(kind: HaxeDualBindingPublicKind): boolean {
  return kind === 'function' || kind === 'value' || kind === 'type-value';
}

export function isHaxeDualBindingType(kind: HaxeDualBindingPublicKind): boolean {
  return kind === 'type' || kind === 'type-value';
}
