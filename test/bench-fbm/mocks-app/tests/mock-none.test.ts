import { describe, it, expect } from "vitest";
import { fetchUser, API_URL } from "../shared/api";
import { getUserName } from "../shared/service";

describe("no mocks: pristine graph is untouched by other suites' mocks", () => {
  it("sees the real module", () => {
    expect(fetchUser(1).name).toBe("real-1");
    expect(fetchUser(1).source).toBe("network");
    expect(API_URL).toBe("https://real.example");
  });

  it("sees the real module transitively", () => {
    expect(getUserName(4)).toBe("real-4");
  });
});
