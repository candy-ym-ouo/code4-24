import { afterEach, describe, expect, it, vi } from "vitest";
import { request } from "../src/lib/api";

describe("api client", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("returns the API envelope", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ data: { id: "1" } }), { status: 200, headers: { "content-type": "application/json" } })));
    const result = await request<{ data: { id: string } }>("/test");
    expect(result.data.id).toBe("1");
  });

  it("maps structured API errors", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: { code: "INSUFFICIENT_STOCK", message: "库存不足", fieldErrors: {} } }), { status: 409, headers: { "content-type": "application/json" } })));
    await expect(request("/consumptions", { method: "POST", body: {} })).rejects.toMatchObject({
      status: 409,
      code: "INSUFFICIENT_STOCK",
      message: "库存不足"
    });
  });
});
