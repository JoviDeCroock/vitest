import { describe, it, expect, vi } from "vitest";
import { compute, VERSION, helpers } from "../shared/legacy";
import { source } from "../shared/data";
import fsish, { read } from "../shared/fsish";

vi.mock("../shared/legacy"); // no factory, no __mocks__ -> automock
vi.mock("../shared/data"); // resolves to __mocks__/data.ts
vi.mock("../shared/fsish"); // automock with default/named identity

describe("factory-less mocks", () => {
  it("automocks function exports into spies returning undefined", () => {
    expect(vi.isMockFunction(compute)).toBe(true);
    expect(compute(5)).toBeUndefined();
    expect(compute).toHaveBeenCalledWith(5);
  });

  it("keeps non-function exports, deep-mocks nested functions", () => {
    expect(VERSION).toBe("1.2.3");
    expect(vi.isMockFunction(helpers.double)).toBe(true);
  });

  it("uses the adjacent __mocks__ file when present", () => {
    expect(source()).toBe("mock-data");
  });

  it("default-export members and named exports share one spy", () => {
    expect(vi.isMockFunction(read)).toBe(true);
    expect(fsish.read).toBe(read);
    vi.mocked(read).mockReturnValue("stub");
    expect(fsish.read("k")).toBe("stub");
  });

  it("importMock returns the mocked namespace", async () => {
    const mocked = await vi.importMock<typeof import("../shared/data")>("../shared/data");
    expect(mocked.source()).toBe("mock-data");
  });
});
