import { describe, it, expect, vi } from "vitest";
import { fetchUser, API_URL } from "../shared/api";
import { source } from "../shared/data";

vi.mock("../shared/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../shared/api")>();
  return { ...actual, API_URL: "https://partial.example" };
});

vi.mock("../shared/data", async () => {
  const actual = await vi.importActual<typeof import("../shared/data")>("../shared/data");
  return { ...actual, extra: "added" };
});

describe("partial mocks", () => {
  it("importOriginal keeps real exports and overrides one", () => {
    expect(fetchUser(2).source).toBe("network");
    expect(API_URL).toBe("https://partial.example");
  });

  it("vi.importActual inside a factory works too", async () => {
    expect(source()).toBe("real-data"); // factory wins over __mocks__, keeps actual
    const mod: any = await import("../shared/data");
    expect(mod.extra).toBe("added");
  });
});
