import { describe, expect, it } from "vitest";
import { cosineSimilarity } from "./hybrid_sensor.js";

describe("cosineSimilarity", () => {
  it("scores identical and opposing vectors", () => {
    expect(cosineSimilarity([1, 0], [1, 0])).toBe(1);
    expect(cosineSimilarity([1, 0], [0, 1])).toBe(0);
    expect(cosineSimilarity([1, 0], [-1, 0])).toBe(-1);
  });

  it("scores unusable vectors as 0 instead of throwing", () => {
    expect(cosineSimilarity([], [])).toBe(0);
    expect(cosineSimilarity([1, 0], [1, 0, 0])).toBe(0);
    expect(cosineSimilarity([0, 0], [1, 1])).toBe(0);
    expect(cosineSimilarity([Number.NaN], [1])).toBe(0);
  });
});
