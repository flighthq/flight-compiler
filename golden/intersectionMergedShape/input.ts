interface A {
  a?: number;
  shared: string;
}

interface B {
  b: string;
  shared: string;
}

type BAlias = B;

// Every conjunct resolves, so the intersection is one minted shape: the optional member stays optional,
// the member both conjuncts declare appears once, and an alias spelling is the conjunct it names.
export function read(value: A & BAlias): number | undefined {
  return value.a;
}
