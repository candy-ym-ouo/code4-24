import { describe, expect, it } from "vitest";
import {
  addQuantities,
  compareQuantities,
  convertQuantity,
  moneyAmount,
  positiveQuantity,
  quantitiesAreCompatible,
  subtractQuantities
} from "../src/index.js";

describe("fixed decimal quantity operations", () => {
  it("converts kilograms to grams without floating point arithmetic", () => {
    expect(convertQuantity("1.5", "kg", "g")).toBe("1500.000000");
    expect(convertQuantity("0.000001", "kg", "g")).toBe("0.001000");
  });

  it("preserves six-decimal precision at large values", () => {
    expect(addQuantities("999999999999.999999", "0.000001")).toBe("1000000000000.000000");
    expect(subtractQuantities("1000.000000", "0.000001")).toBe("999.999999");
    expect(compareQuantities("0.000001", "0")).toBe(1);
  });

  it("rejects incompatible units", () => {
    expect(() => convertQuantity("1", "g", "ml")).toThrow("UNIT_INCOMPATIBLE");
    expect(quantitiesAreCompatible("cm", "m")).toBe(true);
  });

  it("enforces positive quantities and two-decimal money", () => {
    expect(positiveQuantity.safeParse("0").success).toBe(false);
    expect(positiveQuantity.safeParse("0.000001").success).toBe(true);
    expect(moneyAmount.safeParse("12.34").success).toBe(true);
    expect(moneyAmount.safeParse("12.345").success).toBe(false);
  });
});
