import { greet } from "./nsmod";

export function greetTwice(name: string): string {
  return `${greet(name)}|${greet(name)}`;
}
