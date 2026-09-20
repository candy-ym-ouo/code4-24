<script setup lang="ts">
import { onMounted, reactive, ref } from "vue";
import { ElMessage } from "element-plus";
import { request, ApiError } from "@/lib/api";
import type { ApiMeta } from "@/types";

const loading = ref(false);
const rows = ref<any[]>([]);
const meta = reactive<ApiMeta>({ page: 1, pageSize: 20, total: 0, totalPages: 0 });
const filters = reactive({ entityType: "", action: "" });
async function load(page = 1) {
  loading.value = true;
  try {
    const params = new URLSearchParams({ page: String(page), pageSize: "20" });
    for (const [key, value] of Object.entries(filters)) if (value) params.set(key, value);
    const response = await request<{ data: any[]; meta: ApiMeta }>(`/audit-logs?${params}`);
    rows.value = response.data; Object.assign(meta, response.meta);
  } catch (error) { ElMessage.error(error instanceof ApiError ? error.message : "审计日志加载失败"); }
  finally { loading.value = false; }
}
onMounted(() => load());
</script>

<template>
  <div>
    <header class="page-header"><div><h1>审计日志</h1><p>创建、修改、归档、库存调整、消耗和撤销都会留下记录。</p></div></header>
    <section class="toolbar"><el-form :inline="true" @submit.prevent="load(1)">
      <el-form-item label="对象类型"><el-input v-model="filters.entityType" placeholder="例如 BATCH" /></el-form-item>
      <el-form-item label="动作"><el-input v-model="filters.action" placeholder="例如 ADJUST" /></el-form-item>
      <el-form-item><el-button type="primary" @click="load(1)">搜索</el-button></el-form-item>
    </el-form></section>
    <section class="panel">
      <el-table v-loading="loading" :data="rows">
        <el-table-column label="时间" width="180"><template #default="{ row }">{{ new Date(row.createdAt).toLocaleString() }}</template></el-table-column>
        <el-table-column label="操作员" prop="actorName" width="130" />
        <el-table-column label="对象" width="170"><template #default="{ row }">{{ row.entityType }}<div class="muted">{{ row.entityId || "无具体 ID" }}</div></template></el-table-column>
        <el-table-column label="动作" prop="action" width="130" />
        <el-table-column label="变更摘要" min-width="280"><template #default="{ row }"><code style="white-space:pre-wrap;word-break:break-all">{{ JSON.stringify(row.afterData || row.beforeData || {}) }}</code></template></el-table-column>
      </el-table>
      <el-empty v-if="!loading && rows.length===0" description="还没有审计记录" />
      <el-pagination v-if="meta.total>0" style="margin-top:16px;justify-content:flex-end" layout="total, prev, pager, next" :total="meta.total" :page-size="meta.pageSize" :current-page="meta.page" @current-change="load" />
    </section>
  </div>
</template>
