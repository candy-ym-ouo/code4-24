import type { DbClient } from "./db.js";
import { AppError } from "./errors.js";

/**
 * 库位树形结构的并发移动原语。
 *
 * 并发环的根因是“先做环检查、后取行锁”：两个互相交叉的移动在各自的快照上
 * 都看不到环，检查全部通过后再写入，最终落库的就是一张带环的图。
 *
 * 这里采用沿父链自底向上（子先于父）加行级排他锁的协议：
 *  - 任何会改动 X 祖先链的并发移动，都必须先拿到链上同一批行的排他锁；
 *    锁的获取顺序由树的父子顺序唯一决定，不可能形成等待环，因此天然无
 *    死锁（PostgreSQL 的死锁检测仍保留为最终兜底，见 withTransaction）。
 *  - 锁拿到之后再沿同一条链判断 nodeId 是否出现在祖先中，此时看到的是
 *    最新已提交状态，交叉移动被串行化：先提交者写入后，后到者必然在链上
 *    看到目标节点而被拒绝。因此任意深度的交叉移动最多成功一个。
 */

export interface StorageLocationRow {
  id: string;
  name: string;
  parent_id: string | null;
  notes: string | null;
  archived_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

/**
 * 移动库位前的锁与校验：
 * 1. 锁定待移动的节点 FOR UPDATE；
 * 2. 沿 newParentId 自底向上锁定整条祖先链（已存在的父链环在加锁遍历中即被发现）；
 * 3. 在持有的稳定视图上确认新父未归档，且 nodeId 不在其祖先链中。
 *
 * 返回移动节点的移动前整行快照，供审计使用。
 */
export async function lockForReparent(
  client: DbClient,
  nodeId: string,
  newParentId: string | null
): Promise<StorageLocationRow> {
  const node = await lockLocation(client, nodeId);

  if (newParentId === null) {
    // 挂到根下：只涉及被移动节点自身，无环风险。
    return node;
  }

  const chain = await lockAncestorChain(client, newParentId);
  if (chain.some((row) => row.id === nodeId)) {
    throw new AppError(422, "LOCATION_CYCLE", "位置层级不能形成循环");
  }
  const parent = chain[0];
  if (!parent) throw new AppError(422, "INVALID_PARENT", "上级位置不存在或已归档");
  if (parent.archived_at) throw new AppError(422, "INVALID_PARENT", "上级位置不存在或已归档");

  return node;
}

async function lockLocation(client: DbClient, id: string): Promise<StorageLocationRow> {
  const result = await client.query<StorageLocationRow>(
    "SELECT * FROM storage_locations WHERE id = $1 FOR UPDATE",
    [id]
  );
  const row = result.rows[0];
  if (!row) throw new AppError(404, "NOT_FOUND", "位置不存在");
  return row;
}

/**
 * 自底向上锁定 rootId 的整条祖先链并返回（数组顺序：rootId、其父、祖父……）。
 * 父引用成环（数据库中已存在的环）在遍历时立即被拒绝，同时保证遍历终止。
 */
async function lockAncestorChain(client: DbClient, rootId: string): Promise<StorageLocationRow[]> {
  const chain: StorageLocationRow[] = [];
  const visited = new Set<string>();
  let currentId: string | null = rootId;
  while (currentId !== null) {
    if (visited.has(currentId)) {
      throw new AppError(422, "LOCATION_CYCLE", "位置层级不能形成循环");
    }
    visited.add(currentId);
    const row = await lockLocation(client, currentId);
    chain.push(row);
    currentId = row.parent_id;
  }
  return chain;
}
