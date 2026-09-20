<script setup lang="ts">
import { onMounted, reactive, ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import { ElMessage } from "element-plus";
import { request, ApiError } from "@/lib/api";
import { craftTypeLabels, statusLabels, type ApiMeta, type Project } from "@/types";

const route = useRoute();
const router = useRouter();
const loading = ref(false);
const rows = ref<Project[]>([]);
const meta = reactive<ApiMeta>({ page: 1, pageSize: 20, total: 0, totalPages: 0 });
const filters = reactive({ q: "", craftType: "", status: "" });
async function load(page = 1) {
  loading.value = true;
  try {
    const params = new URLSearchParams({ page: String(page), pageSize: "20" });
    for (const [key, value] of Object.entries(filters)) if (value) params.set(key, value);
    const response = await request<{ data: Project[]; meta: ApiMeta }>(`/projects?${params}`);
    rows.value = response.data; Object.assign(meta, response.meta);
    await router.replace({ query: Object.fromEntries(params) });
  } catch (error) { ElMessage.error(error instanceof ApiError ? error.message : "项目加载失败"); }
  finally { loading.value = false; }
}
onMounted(() => {
  Object.assign(filters, { q: String(route.query.q || ''), craftType: String(route.query.craftType || ''), status: String(route.query.status || '') });
  void load(Number(route.query.page) || 1);
});
</script>

<template>
  <div>
    <header class="page-header"><div><h1>项目</h1><p>计划用料与实际消耗分开统计，只有消耗才扣减库存。</p></div><el-button type="primary" @click="router.push('/projects/new')">新建项目</el-button></header>
    <section class="toolbar"><el-form :inline="true" @submit.prevent="load(1)">
      <el-form-item label="关键词"><el-input v-model="filters.q" clearable @keyup.enter="load(1)" /></el-form-item>
      <el-form-item label="工艺"><el-select v-model="filters.craftType" clearable style="width:130px"><el-option v-for="(label,value) in craftTypeLabels" :key="value" :value="value" :label="label" /></el-select></el-form-item>
      <el-form-item label="状态"><el-select v-model="filters.status" clearable style="width:130px"><el-option value="PLANNED" label="计划中" /><el-option value="IN_PROGRESS" label="进行中" /><el-option value="COMPLETED" label="已完成" /></el-select></el-form-item>
      <el-form-item><el-button type="primary" @click="load(1)">搜索</el-button></el-form-item>
    </el-form></section>
    <section class="panel">
      <el-table v-loading="loading" :data="rows">
        <el-table-column label="项目" min-width="220"><template #default="{ row }"><router-link :to="`/projects/${row.id}`"><strong>{{ row.name }}</strong></router-link><div class="muted">{{ row.description || "无描述" }}</div></template></el-table-column>
        <el-table-column label="工艺" width="100"><template #default="{ row }">{{ craftTypeLabels[row.craftType] || row.craftType }}</template></el-table-column>
        <el-table-column label="状态" width="100"><template #default="{ row }"><el-tag :type="row.status==='IN_PROGRESS'?'warning':row.status==='COMPLETED'?'success':'info'">{{ statusLabels[row.status] || row.status }}</el-tag></template></el-table-column>
        <el-table-column label="需求" prop="requirementCount" width="80" />
        <el-table-column label="消耗笔数" prop="consumptionCount" width="100" />
        <el-table-column label="计划/截止" width="150"><template #default="{ row }">{{ row.startDate || "未定" }}<div class="muted">{{ row.dueDate || "无截止日期" }}</div></template></el-table-column>
        <el-table-column label="操作" width="100" fixed="right"><template #default="{ row }"><el-button link type="primary" @click="router.push(`/projects/${row.id}`)">查看</el-button></template></el-table-column>
      </el-table>
      <el-empty v-if="!loading && rows.length===0" description="还没有项目记录"><el-button type="primary" @click="router.push('/projects/new')">建立第一个项目</el-button></el-empty>
      <el-pagination v-if="meta.total>0" style="margin-top:16px;justify-content:flex-end" layout="total, prev, pager, next" :total="meta.total" :page-size="meta.pageSize" :current-page="meta.page" @current-change="load" />
    </section>
  </div>
</template>
