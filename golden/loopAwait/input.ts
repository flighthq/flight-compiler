export async function total(task: Promise<number>, again: boolean): Promise<number> {
  let sum: number = 0;
  let pending: boolean = true;
  while (pending) {
    const value = await task;
    sum = sum + value;
    pending = again;
    again = false;
  }
  return sum;
}
