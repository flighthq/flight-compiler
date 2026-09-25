interface A {
  a: number;
}

interface B {
  a: string;
}

// Two conjuncts declare `a` at different types, so the intersection has no type for that member.
export function read(_value: A & B): number {
  return 1;
}
