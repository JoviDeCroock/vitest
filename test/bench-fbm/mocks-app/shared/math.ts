export function add(a: number, b: number): number {
  return a + b;
}

export function fib(n: number): number {
  return n <= 1 ? n : fib(n - 1) + fib(n - 2);
}

export const constants = { answer: 42, greeting: "hallo" };
