export async function choose(task: Promise<number>, flag: boolean): Promise<number> {
  let total: number = 0;
  if (flag) {
    total = await task;
  } else {
    total = 1;
  }
  return total;
}
