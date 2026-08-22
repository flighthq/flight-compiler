export async function decide(task: Promise<boolean>): Promise<number> {
  let total: number = 0;
  if (await task) {
    total = 1;
  } else {
    total = 2;
  }
  return total;
}
