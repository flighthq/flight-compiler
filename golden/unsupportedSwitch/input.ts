export function classify(value: number): number {
  switch (value) {
    case 1:
    case 2:
      return 5;
    default:
      return 0;
  }
}
