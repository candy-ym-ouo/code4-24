<script setup lang="ts">
import { onMounted, reactive, ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import { ElMessage } from "element-plus";
import { request, ApiError } from "@/lib/api";
import { statusLabels, type ApiMeta, type Batch } from "@/types";

const route = useRoute();
const router = useRouter();
const loading = ref(false);
const rows = ref<Batch[]>([]);
const meta = reactive<ApiMeta>({ page: 1, pageSize: 20, total: 0, totalPages: 0 });
const filters = reactive({ q: "", status: "", color: "", expiryBefore: "" });

async function load(page = 1) {
  loading.value = true;
  try {
    const params = new URLSearchParams({ page: String(page), pageSize: "20" });
    for (const [key, value] of Object.entries(filters)) if (value) params.set(key, value);
    const response = await request<{ data: Batch[]; meta: ApiMeta }>(`/batches?${params}`);
    rows.value = response.data;
    Object.assign(meta, response.meta);
    await router.replace({ query: Object.fromEntries(params) });
  } catch (error) {
    ElMessage.error(error instanceof ApiError ? error.message : "批次加载失败");
  } finally {
    loading.value = false;
  }
}

function reset() {
  Object.assign(filters, { q: "", status: "", color: "", expiryBefore: "" });
  void load(1);
}
onMounted(() => {
  Object.assign(filters, {
    q: String(route.query.q || ''),
    status: String(route.query.status || ''),
    color: String(route.query.color || ''),
    expiryBefore: String(route.query.expiryBefore || '')
  });
  void load(Number(route.query.page) || 1);
});
</script>

<template>
  <div>
    <header class="page-header">
      <div><h1>批次库存</h1><p>每次实际取得、拆分或保留的材料都以独立批次核算。</p></div>
      <el-button type="primary" @click="router.push('/batches/new')">新批次入库</el-button>
    </header>
    <section class="toolbar">
      <el-form :inline="true" @submit.prevent="load(1)">
        <el-form-item label="关键词"><el-input v-model="filters.q" clearable placeholder="材料、批次号、来源、颜色" @keyup.enter="load(1)" /></el-form-item>
        <el-form-item label="颜色"><el-input v-model="filters.color" clearable style="width: 150px" /></el-form-item>
        <el-form-item label="状态">
          <el-select v-model="filters.status" clearable style="width: 130px"><el-option value="ACTIVE" label="有库存" /><el-option value="DEPLETED" label="已耗尽" /><el-option value="ARCHIVED" label="已归档" /></el-select>
        </el-form-item>
        <el-form-item label="到期不晚于"><el-date-picker v-model="filters.expiryBefore" value-format="YYYY-MM-DD" type="date" /></el-form-item>
        <el-form-item><el-button type="primary" @click="load(1)">搜索</el-button><el-button @click="reset">重置</el-button></el-form-item>
      </el-form>
    </section>
    <section class="panel">
      <el-table v-loading="loading" :data="rows">
        <el-table-column label="材料/批次" min-width="210">
          <template #default="{ row }"><router-link :to="`/batches/${row.id}`"><strong>{{ row.materialName }}</strong></router-link><div class="muted">{{ row.batchCode || "无批次号" }} · {{ row.sourceName || "来源不明" }}</div></template>
        </el-table-column>
        <el-table-column label="剩余/初始" width="180"><template #default="{ row }"><span class="amount">{{ row.remainingQuantity }} / {{ row.initialQuantity }} {{ row.stockUnit }}</span></template></el-table-column>
        <el-table-column label="当前颜色" width="150"><template #default="{ row }"><span v-if="row.currentColorHex" class="color-dot" :style="{ background: row.currentColorHex }" />{{ row.currentColorName || "未记录" }}</template></el-table-column>
        <el-table-column label="存放位置" min-width="130"><template #default="{ row }">{{ row.locationName || "未指定" }}</template></el-table-column>
        <el-table-column label="入库/到期" width="160"><template #default="{ row }">{{ row.receivedAt }}<div class="muted">{{ row.expiryAt || "无有效期" }}</div></template></el-table-column>
        <el-table-column label="状态" width="100"><template #default="{ row }"><el-tag :type="row.status === 'ACTIVE' ? 'success' : row.status === 'ARCHIVED' ? 'info' : 'warning'">{{ statusLabels[row.status] || row.status }}</el-tag></template></el-table-column>
        <el-table-column label="操作" width="110" fixed="right"><template #default="{ row }"><el-button link type="primary" @click="router.push(`/batches/${row.id}`)">查看与操作</el-button></template></el-table-column>
      </el-table>
      <el-empty v-if="!loading && rows.length === 0" description="没有符合条件的批次" />
      <el-pagination v-if="meta.total > 0" style="margin-top:16px; justify-content:flex-end" layout="total, prev, pager, next" :total="meta.total" :page-size="meta.pageSize" :current-page="meta.page" @current-change="load" />
    </section>
  </div>
</template>
