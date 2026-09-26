interface EntityRuntime {
  readonly kind: string;
}

interface Other {
  readonly tag: number;
}

class ConcreteRuntime implements EntityRuntime {
  readonly kind: string = 'c';
}

// A class instance reaches an interface slot as a PROJECTED row: the emitter builds a fresh
// `EntityRuntime` from the instance's members, so the instance's own identity is gone before any assertion
// runs and there is no pointer for a cast to follow. Narrowing back would need a type tag the interface
// carrier does not hold -- runtime metadata, not a lowering this compiler can supply.
export function narrow(value: EntityRuntime | Other): ConcreteRuntime {
  return value as ConcreteRuntime;
}
