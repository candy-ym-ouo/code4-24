<script setup lang="ts">
import { onMounted, reactive, ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import { ElMessage } from "element-plus";
import { request, ApiError } from "@/lib/api";
import { craftTypeLabels, type ApiMeta, type Material } from "@/types";

const route = useRoute();
const router = useRouter();
const loading = ref(false);
const rows = ref<Material[]>([]);
const meta = reactive<ApiMeta>({ page: 1, pageSize: 20, total: 0, totalPages: 0 });
const filters = reactive({ q: "", craftType: "", stockState: "", color: "" });

const craftOptions = Object.entries(craftTypeLabels);

async function load(page = 1) {
  loading.value = true;
  try {
    const params = new URLSearchParams({ page: String(page), pageSize: "20" });
    for (const [key, value] of Object.entries(filters)) if (value) params.set(key, value);
    const response = await request<{ data: Material[]; meta: ApiMeta }>(`/materials?${params}`);
    rows.value = response.data;
    Object.assign(meta, response.meta);
    await router.replace({ query: Object.fromEntries(params) });
  } catch (error) {
    ElMessage.error(error instanceof ApiError ? error.message : "材料加载失败");
  } finally {
    loading.value = false;
  }
}

function reset() {
  Object.assign(filters, { q: "", craftType: "", stockState: "", color: "" });
  void load(1);
}

onMounted(() => {
  Object.assign(filters, {
    q: String(route.query.q || ''),
    craftType: String(route.query.craftType || ''),
    stockState: String(route.query.stockState || ''),
    color: String(route.query.color || '')
  });
  void load(Number(route.query.page) || 1);
});
</script>

<template>
  <div>
    <header class="page-header">
      <div><h1>材料档案</h1><p>材料是长期档案，真实数量来自其下所有批次。</p></div>
      <el-button type="primary" @click="router.push('/materials/new')">新建材料</el-button>
    </header>
    <section class="toolbar">
      <el-form :inline="true" @submit.prevent="load(1)">
        <el-form-item label="关键词"><el-input v-model="filters.q" clearable placeholder="名称、标签、批次、来源" @keyup.enter="load(1)" /></el-form-item>
        <el-form-item label="工艺">
          <el-select v-model="filters.craftType" clearable style="width: 130px"><el-option v-for="[value,label] in craftOptions" :key="value" :value="value" :label="label" /></el-select>
        </el-form-item>
        <el-form-item label="颜色"><el-input v-model="filters.color" clearable placeholder="颜色名或色值" style="width: 160px" /></el-form-item>
        <el-form-item label="库存">
          <el-select v-model="filters.stockState" clearable style="width: 130px">
            <el-option value="in_stock" label="有货" /><el-option value="low_stock" label="低库存" /><el-option value="out_of_stock" label="无货" />
          </el-select>
        </el-form-item>
        <el-form-item><el-button type="primary" @click="load(1)">搜索</el-button><el-button @click="reset">重置</el-button></el-form-item>
      </el-form>
    </section>

    <section class="panel">
      <el-table v-loading="loading" :data="rows">
        <el-table-column label="材料" min-width="210">
          <template #default="{ row }">
            <router-link :to="`/materials/${row.id}`"><strong>{{ row.name }}</strong></router-link>
            <div class="muted">{{ row.code || "无编码" }} · {{ row.subtype || "未分类" }}</div>
          </template>
        </el-table-column>
        <el-table-column label="适用工艺" min-width="180">
          <template #default="{ row }"><el-tag v-for="type in row.craftTypes" :key="type" size="small" style="margin-right: 4px">{{ craftTypeLabels[type] || type }}</el-tag></template>
        </el-table-column>
        <el-table-column label="默认颜色" width="130">
          <template #default="{ row }"><span v-if="row.defaultColorHex" class="color-dot" :style="{ background: row.defaultColorHex }" />{{ row.defaultColorName || "未设置" }}</template>
        </el-table-column>
        <el-table-column label="剩余库存" width="160">
          <template #default="{ row }"><span class="amount">{{ row.remainingQuantity }} {{ row.stockUnit }}</span><div class="muted">{{ row.batchCount }} 个批次</div></template>
        </el-table-column>
        <el-table-column label="状态" width="110">
          <template #default="{ row }">
            <el-tag :type="row.stockState === 'out_of_stock' ? 'info' : row.stockState === 'low_stock' ? 'warning' : 'success'">
              {{ row.stockState === "out_of_stock" ? "无货" : row.stockState === "low_stock" ? "低库存" : "有货" }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="170" fixed="right">
          <template #default="{ row }">
            <el-button link type="primary" @click="router.push(`/materials/${row.id}`)">详情</el-button>
            <el-button link @click="router.push(`/materials/${row.id}/edit`)">编辑</el-button>
            <el-button link type="success" @click="router.push({ path: '/batches/new', query: { materialId: row.id } })">入库</el-button>
          </template>
        </el-table-column>
      </el-table>
      <el-empty v-if="!loading && rows.length === 0" description="没有符合条件的材料">
        <el-button type="primary" @click="router.push('/materials/new')">建立第一个材料档案</el-button>
      </el-empty>
      <el-pagination v-if="meta.total > 0" style="margin-top: 16px; justify-content: flex-end" layout="total, prev, pager, next" :total="meta.total" :page-size="meta.pageSize" :current-page="meta.page" @current-change="load" />
    </section>
  </div>
</template>
