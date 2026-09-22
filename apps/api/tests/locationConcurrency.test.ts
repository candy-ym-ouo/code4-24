import { describe, expect, it } from "vitest";
import { isRetryableTransactionError } from "../src/lib/db.js";

describe("isRetryableTransactionError", () => {
  it("accepts PostgreSQL deadlock and serialization failure codes", () => {
    expect(isRetryableTransactionError({ code: "40P01" })).toBe(true);
    expect(isRetryableTransactionError({ code: "40001" })).toBe(true);
  });

  it("rejects business and unrelated errors", () => {
    expect(isRetryableTransactionError({ code: "23514" })).toBe(false);
    expect(isRetryableTransactionError(new Error("boom"))).toBe(false);
    expect(isRetryableTransactionError(null)).toBe(false);
    expect(isRetryableTransactionError("40P01")).toBe(false);
  });
});

/**
 * 用内存实现模拟 PostgreSQL 的行级排他锁：
 *  - FOR UPDATE 以 FIFO 方式等待，锁释放后每行只放行一个等待者；
 *  - 等待图成环时（40P01）选择刚加入的事务为牺牲品，中止其等待；
 *  - READ COMMITTED 下重试是全新事务，按最新已提交状态重新取锁、重新检查。
 *
 * 被驱动的算法与 src/lib/locationTree.ts 的 lockForReparent 完全一致
 * （先锁自身，再自底向上锁祖先链，锁内判环），外层再套与
 * withTransaction({ attempts: 3 }) 一致的死锁重试。
 */
describe("location reparent concurrency protocol", () => {
  it("serializes two cross moves: exactly one commits, loser gets LOCATION_CYCLE", async () => {
    const env = new PgSim({ A: null, B: null });
    const before = env.snapshot();
    const results = await runConcurrently(env, [
      ["A", "B"],
      ["B", "A"]
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.find((r) => !r.ok)?.code).toBe("LOCATION_CYCLE");
    expect(env.hasCycle()).toBe(false);
    expect(env.allParentsExist()).toBe(true);
    for (const r of results) {
      if (!r.ok) expect(env.parents.get(r.nodeId)).toBe(before.get(r.nodeId));
    }
  });

  it("breaks a 3-way rotation: crossing pair has at most one winner and no cycle", async () => {
    const env = new PgSim({ A: null, B: "A", C: "B" });
    const before = env.snapshot();
    // A->C、B->A、C->B 都单独合法，全部成功则形成 A->C->B->A 三环。
    const results = await runConcurrently(env, [
      ["A", "C"],
      ["B", "A"],
      ["C", "B"]
    ]);
    expect(env.hasCycle()).toBe(false);
    expect(env.allParentsExist()).toBe(true);
    // A->C 与 C->B 是会成环的交叉对，最多一个成功。
    const aToC = results[0];
    const cToB = results[2];
    expect(aToC).toBeDefined();
    expect(cToB).toBeDefined();
    const pairWinners = [aToC, cToB].filter((r) => r?.ok).length;
    expect(pairWinners).toBeLessThanOrEqual(1);
    for (const r of results.filter((x) => !x.ok)) {
      expect(r.code).toBe("LOCATION_CYCLE");
      expect(env.parents.get(r.nodeId)).toBe(before.get(r.nodeId));
    }
  });

  it("serializes a depth-5 cross move with exactly one winner", async () => {
    const env = new PgSim({ A: null, B: "A", C: "B", D: "C", E: "D" });
    const results = await runConcurrently(env, [
      ["A", "E"],
      ["E", "A"]
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.find((r) => !r.ok)?.code).toBe("LOCATION_CYCLE");
    expect(env.hasCycle()).toBe(false);
  });

  it("allows independent moves on disjoint subtrees", async () => {
    const env = new PgSim({ A: null, B: "A", C: null, D: "C" });
    const results = await runConcurrently(env, [
      ["B", null],
      ["D", null]
    ]);
    expect(results.every((r) => r.ok)).toBe(true);
    expect(env.hasCycle()).toBe(false);
  });

  it("handles two independent cross-move pairs, one winner per pair", async () => {
    const env = new PgSim({ A: null, B: "A", C: null, D: "C" });
    const before = env.snapshot();
    const results = await runConcurrently(env, [
      ["A", "B"],
      ["B", "A"],
      ["C", "D"],
      ["D", "C"]
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(2);
    expect(env.hasCycle()).toBe(false);
    for (const r of results.filter((x) => !x.ok)) {
      expect(r.code).toBe("LOCATION_CYCLE");
      expect(env.parents.get(r.nodeId)).toBe(before.get(r.nodeId));
    }
  });
});

class PgSim {
  readonly parents: Map<string, string | null>;
  private rowLocks = new Map<string, number>();
  private waiters: Array<{ tx: number; row: string; aborted: boolean; resolve: () => void; reject: (e: unknown) => void }> = [];
  private txSeq = 0;

  constructor(initial: Record<string, string | null>) {
    this.parents = new Map(Object.entries(initial));
  }

  begin(): number {
    this.txSeq += 1;
    return this.txSeq;
  }

  private detectsDeadlock(tx: number): boolean {
    // 从 tx 沿“等待行持有者”向上，若回到 tx 则等待图含环。
    const seen = new Set<number>();
    const stack: number[] = [tx];
    while (stack.length > 0) {
      const current = stack.pop() as number;
      if (current === tx && seen.size > 0) return true;
      if (seen.has(current)) continue;
      seen.add(current);
      for (const w of this.waiters.filter((x) => x.tx === current)) {
        const owner = this.rowLocks.get(w.row);
        if (owner !== undefined) stack.push(owner);
      }
    }
    return false;
  }

  async acquire(tx: number, row: string): Promise<void> {
    const owner = this.rowLocks.get(row);
    if (owner === undefined || owner === tx) {
      this.rowLocks.set(row, tx);
      return;
    }
    const waiter = {
      tx,
      row,
      aborted: false,
      resolve: () => undefined,
      reject: () => undefined
    } as { tx: number; row: string; aborted: boolean; resolve: () => void; reject: (e: unknown) => void };
    const promise = new Promise<void>((resolve, reject) => {
      waiter.resolve = resolve;
      waiter.reject = reject;
    });
    this.waiters.push(waiter);
    if (this.detectsDeadlock(tx)) {
      waiter.aborted = true;
      this.waiters = this.waiters.filter((w) => w !== waiter);
      waiter.reject(Object.assign(new Error("deadlock detected"), { code: "40P01" }));
    }
    await promise;
    this.rowLocks.set(row, tx);
  }

  commit(tx: number, pending: { nodeId: string; parentId: string | null } | null): void {
    if (pending) this.parents.set(pending.nodeId, pending.parentId);
    this.release(tx);
  }

  rollback(tx: number): void {
    this.release(tx);
  }

  private release(tx: number): void {
    for (const [row, owner] of this.rowLocks) {
      if (owner === tx) this.rowLocks.delete(row);
    }
    // 排他锁：释放后每行只放行一个等待者。
    const granted = new Set<string>();
    const remaining = this.waiters.filter((w) => w.aborted || this.rowLocks.has(w.row) || granted.has(w.row));
    const ready = this.waiters.filter((w) => !remaining.includes(w));
    this.waiters = remaining;
    for (const w of ready) {
      granted.add(w.row);
      this.rowLocks.set(w.row, w.tx);
      w.resolve();
    }
  }

  update(tx: number, nodeId: string, parentId: string | null): { nodeId: string; parentId: string | null } {
    if (this.rowLocks.get(nodeId) !== tx) throw new Error("update without row lock");
    return { nodeId, parentId };
  }

  snapshot(): Map<string, string | null> {
    return new Map(this.parents);
  }

  hasCycle(): boolean {
    const color = new Map<string, 0 | 1 | 2>();
    const dfs = (id: string): boolean => {
      const state = color.get(id) ?? 0;
      if (state === 1) return true;
      if (state === 2) return false;
      color.set(id, 1);
      const parent = this.parents.get(id);
      if (parent !== undefined && parent !== null && dfs(parent)) return true;
      color.set(id, 2);
      return false;
    };
    return [...this.parents.keys()].some((id) => dfs(id));
  }

  allParentsExist(): boolean {
    return [...this.parents.values()].every((p) => p === null || this.parents.has(p));
  }
}

// 与 lockForReparent 相同的加锁与判环步骤。
async function reparentAttempt(
  env: PgSim,
  tx: number,
  nodeId: string,
  newParentId: string | null
): Promise<{ nodeId: string; parentId: string | null }> {
  if (!env.parents.has(nodeId)) throw Object.assign(new Error("not found"), { statusCode: 404, code: "NOT_FOUND" });
  if (newParentId === nodeId) throw Object.assign(new Error("self parent"), { statusCode: 422, code: "LOCATION_CYCLE" });
  await env.acquire(tx, nodeId);
  if (newParentId !== null) {
    const visited = new Set<string>();
    let current: string | null = newParentId;
    while (current !== null) {
      if (visited.has(current)) {
        throw Object.assign(new Error("cycle"), { statusCode: 422, code: "LOCATION_CYCLE" });
      }
      visited.add(current);
      if (!env.parents.has(current)) {
        throw Object.assign(new Error("missing parent"), { statusCode: 422, code: "INVALID_PARENT" });
      }
      await env.acquire(tx, current);
      if (current === nodeId) {
        throw Object.assign(new Error("cycle"), { statusCode: 422, code: "LOCATION_CYCLE" });
      }
      current = env.parents.get(current) ?? null;
    }
  }
  return env.update(tx, nodeId, newParentId);
}

// 与 withTransaction({ attempts: 3 }) 一致：40P01 重开全新事务，业务错误立即失败。
async function moveWithRetry(
  env: PgSim,
  nodeId: string,
  newParentId: string | null,
  attempts = 3
): Promise<{ nodeId: string; ok: boolean; code?: string }> {
  let lastCode: string | undefined;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const tx = env.begin();
    let pending: { nodeId: string; parentId: string | null } | null = null;
    try {
      pending = await reparentAttempt(env, tx, nodeId, newParentId);
      env.commit(tx, pending);
      return { nodeId, ok: true };
    } catch (error) {
      env.rollback(tx);
      const code = (error as { code?: string }).code;
      lastCode = code;
      if (code !== "40P01") return { nodeId, ok: false, code };
    }
  }
  return { nodeId, ok: false, code: lastCode };
}

async function runConcurrently(
  env: PgSim,
  moves: Array<[string, string | null]>
): Promise<Array<{ nodeId: string; ok: boolean; code?: string }>> {
  return Promise.all(moves.map(([nodeId, parentId]) => moveWithRetry(env, nodeId, parentId)));
}
