import { describe, it, expect, vi } from "vitest";
import { fetchUser, API_URL } from "../shared/api";
import { getUserName } from "../shared/service";

vi.mock("../shared/api", () => ({
  fetchUser: (id: number) => ({ id, name: `mock-b-${id}`, source: "mock-b" }),
  API_URL: "https://mock-b.example",
}));

describe("suite B: same module, different mock than suite A", () => {
  it("gets its own mock, not suite A's", () => {
    expect(fetchUser(1).name).toBe("mock-b-1");
    expect(fetchUser(1).source).toBe("mock-b");
    expect(API_URL).toBe("https://mock-b.example");
  });

  it("transitive imports see suite B's mock", () => {
    expect(getUserName(9)).toBe("mock-b-9");
  });
});
