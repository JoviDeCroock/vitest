import { describe, it, expect, vi } from "vitest";

class FakeWorker {
  kind(): string {
    return "fake";
  }
}

const PREFIX = "scoped";

vi.mock("../shared/service", () => ({
  getUserName: (id: number) => `${PREFIX}-${id}`,
  WorkerClass: FakeWorker,
}));

describe("factory referencing test-file scope (lazy consumption)", () => {
  it("resolves the scoped factory on dynamic import", async () => {
    const mod: any = await import("../shared/service");
    expect(mod.getUserName(3)).toBe("scoped-3");
    expect(new mod.WorkerClass().kind()).toBe("fake");
  });
});
