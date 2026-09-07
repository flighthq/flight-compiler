export function countUp(start: number, steps: number): number {
  let value: number = start;
  for (let i: number = 0; i < steps; i++) {
    value += 1;
  }
  return value;
}

export function countDown(start: number, steps: number): number {
  let value: number = start;
  for (let i: number = 0; i < steps; i++) {
    value -= 1;
  }
  return value;
}

export function stepAccumulate(n: number): number {
  let total: number = 0;
  let step: number = 1;
  for (let i: number = 0; i < n; i++) {
    total += step;
    step += 2;
  }
  return total;
}

export function halvingSteps(value: number): number {
  let count: number = 0;
  let current: number = value;
  while (current > 1) {
    current = Math.floor(current / 2);
    count += 1;
  }
  return count;
}
