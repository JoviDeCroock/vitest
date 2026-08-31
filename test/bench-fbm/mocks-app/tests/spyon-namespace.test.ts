import { describe, it, expect, vi } from "vitest";
import * as nsmod from "../shared/nsmod";
import { greetTwice } from "../shared/ns-consumer";

describe("vi.spyOn on a namespace import", () => {
  it("intercepts calls made through other modules", () => {
    const spy = vi.spyOn(nsmod, "greet").mockReturnValue("spy");
    expect(nsmod.greet("x")).toBe("spy");
    expect(greetTwice("x")).toBe("spy|spy");
    expect(spy).toHaveBeenCalledTimes(3);
    spy.mockRestore();
  });

  it("restores the original implementation", () => {
    expect(greetTwice("y")).toBe("hi y|hi y");
    expect(nsmod.greet("y")).toBe("hi y");
  });

  it("leaves non-function exports intact", () => {
    expect(nsmod.answer).toBe(42);
  });
});
