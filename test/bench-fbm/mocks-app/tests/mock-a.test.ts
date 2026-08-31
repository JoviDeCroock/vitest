import { describe, it, expect, vi } from "vitest";
import { fetchUser, API_URL } from "../shared/api";
import { getUserName } from "../shared/service";

const { fetchSpy } = vi.hoisted(() => ({
  fetchSpy: vi.fn((id: number) => ({ id, name: `mock-a-${id}`, source: "mock-a" })),
}));

vi.mock("../shared/api", () => ({
  fetchUser: fetchSpy,
  API_URL: "https://mock-a.example",
}));

describe("suite A: factory mock with hoisted spy", () => {
  it("replaces direct imports", () => {
    expect(fetchUser(1).name).toBe("mock-a-1");
    expect(API_URL).toBe("https://mock-a.example");
  });

  it("replaces transitive imports (service -> api)", () => {
    expect(getUserName(7)).toBe("mock-a-7");
  });

  it("records calls on the hoisted spy", () => {
    expect(fetchSpy).toHaveBeenCalledWith(1);
    expect(fetchSpy).toHaveBeenCalledWith(7);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("importActual bypasses the mock", async () => {
    const actual = await vi.importActual<typeof import("../shared/api")>("../shared/api");
    expect(actual.fetchUser(3).source).toBe("network");
    expect(actual.API_URL).toBe("https://real.example");
  });
});
