<script setup lang="ts">
import { onMounted, reactive, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { ElMessage, ElMessageBox } from "element-plus";
import { request, ApiError } from "@/lib/api";
import { statusLabels, type ApiMeta, type Batch, type Consumption, type Project } from "@/types";
import { localDateTimeValue } from "@/lib/dates";
import { createIdempotencyKey } from "@/lib/idempotency";

const route = useRoute();
const router = useRouter();
const loading = ref(false);
const saving = ref(false);
const rows = ref<Consumption[]>([]);
const batches = ref<Batch[]>([]);
const projects = ref<Project[]>([]);
const requirements = ref<any[]>([]);
const meta = reactive<ApiMeta>({ page: 1, pageSize: 20, total: 0, totalPages: 0 });
const filters = reactive({ q: "", projectId: "", status: "" });
const dialogVisible = ref(false);
const form = reactive({ projectId: "", projectRequirementId: "", batchId: "", usedQuantity: "", wasteQuantity: "0", unit: "g", consumedAt: localDateTimeValue(), purpose: "", notes: "" });
let requirementRequestId = 0;

watch(() => form.batchId, (id) => { const batch = batches.value.find((item) => item.id === id); if (batch) form.unit = batch.stockUnit; });
watch(() => form.projectId, async (id) => {
  const requestId = ++requirementRequestId;
  form.projectRequirementId = "";
  requirements.value = [];
  if (!id) return;
  try {
    const response = await request<{ data: any }>(`/projects/${id}`);
    if (requestId === requirementRequestId) requirements.value = response.data.requirements;
  } catch {
    if (requestId === requirementRequestId) requirements.value = [];
  }
});

async function load(page = 1) {
  loading.value = true;
  try {
    const params = new URLSearchParams({ page: String(page), pageSize: "20" });
    for (const [key, value] of Object.entries(filters)) if (value) params.set(key, value);
    const response = await request<{ data: Consumption[]; meta: ApiMeta }>(`/consumptions?${params}`);
    rows.value = response.data; Object.assign(meta, response.meta);
    await router.replace({ query: Object.fromEntries(params) });
  } catch (error) { ElMessage.error(error instanceof ApiError ? error.message : "消耗记录加载失败"); }
  finally { loading.value = false; }
}
async function loadOptions() {
  const [projectResponse, batchResponse] = await Promise.all([
    request<{ data: Project[] }>("/projects?pageSize=100"),
    request<{ data: Batch[] }>("/batches?pageSize=100&status=ACTIVE")
  ]);
  projects.value = projectResponse.data.filter((item) => ["PLANNED", "IN_PROGRESS"].includes(item.status));
  batches.value = batchResponse.data;
}
function openCreate() {
  Object.assign(form, { projectId: String(route.query.projectId || ""), projectRequirementId: "", batchId: String(route.query.batchId || ""), usedQuantity: "", wasteQuantity: "0", unit: "g", consumedAt: localDateTimeValue(), purpose: "", notes: "" });
  dialogVisible.value = true;
}
async function submit() {
  saving.value = true;
  try {
    await request("/consumptions", { method: "POST", headers: { "Idempotency-Key": createIdempotencyKey() }, body: { ...form, consumedAt: new Date(form.consumedAt).toISOString(), projectRequirementId: form.projectRequirementId || null, purpose: form.purpose || null, notes: form.notes || null } });
    ElMessage.success("消耗已入账，批次余额和项目实际用量已更新");
    dialogVisible.value = false; await load(meta.page);
  } catch (error) { ElMessage.error(error instanceof ApiError ? error.message : "消耗失败"); }
  finally { saving.value = false; }
}
async function reverse(row: Consumption) {
  try {
    const result = await ElMessageBox.prompt("撤销会创建反向库存流水，原记录仍保留。请输入撤销原因。", "撤销消耗", { inputPattern: /^.{3,}$/, inputErrorMessage: "原因至少 3 个字" });
    await request(`/consumptions/${row.id}/reverse`, { method: "POST", body: { reason: result.value } });
    ElMessage.success("消耗已撤销，库存已恢复"); await load(meta.page);
  } catch (error: any) { if (error !== "cancel" && error !== "close") ElMessage.error(error instanceof ApiError ? error.message : "撤销失败"); }
}
onMounted(async () => {
  const shouldCreate = route.query.create === "1";
  const initialBatchId = String(route.query.batchId || "");
  const initialProjectId = String(route.query.projectId || "");
  Object.assign(filters, {
    q: String(route.query.q || ""),
    projectId: initialProjectId,
    status: String(route.query.status || "")
  });
  try {
    await Promise.all([loadOptions(), load(Number(route.query.page) || 1)]);
    if (shouldCreate) {
      openCreate();
      form.projectId = initialProjectId;
      form.batchId = initialBatchId;
    }
  } catch (error) {
    ElMessage.error(error instanceof ApiError ? error.message : "页面初始化失败");
  }
});
</script>

<template>
  <div>
    <header class="page-header"><div><h1>消耗记录</h1><p>每次实际领用都会扣减具体批次，撤销操作保留完整历史。</p></div><el-button type="primary" @click="openCreate">新增消耗</el-button></header>
    <section class="toolbar"><el-form :inline="true" @submit.prevent="load(1)">
      <el-form-item label="关键词"><el-input v-model="filters.q" clearable @keyup.enter="load(1)" /></el-form-item>
      <el-form-item label="项目"><el-select v-model="filters.projectId" clearable filterable style="width:180px"><el-option v-for="project in projects" :key="project.id" :value="project.id" :label="project.name" /></el-select></el-form-item>
      <el-form-item label="状态"><el-select v-model="filters.status" clearable style="width:120px"><el-option value="ACTIVE" label="有效" /><el-option value="REVERSED" label="已撤销" /></el-select></el-form-item>
      <el-form-item><el-button type="primary" @click="load(1)">搜索</el-button></el-form-item>
    </el-form></section>
    <section class="panel">
      <el-table v-loading="loading" :data="rows">
        <el-table-column label="消耗时间" width="170"><template #default="{ row }">{{ new Date(row.consumedAt).toLocaleString() }}</template></el-table-column>
        <el-table-column label="项目" min-width="160"><template #default="{ row }"><router-link :to="`/projects/${row.projectId}`">{{ row.projectName }}</router-link></template></el-table-column>
        <el-table-column label="材料/批次" min-width="180"><template #default="{ row }"><router-link :to="`/batches/${row.batchId}`">{{ row.materialName }}</router-link><div class="muted">{{ row.batchCode || row.batchId }}</div></template></el-table-column>
        <el-table-column label="使用/损耗" width="160"><template #default="{ row }">{{ row.usedQuantity }} / {{ row.wasteQuantity }} {{ row.stockUnit }}</template></el-table-column>
        <el-table-column label="总扣减" width="130"><template #default="{ row }"><span class="amount">{{ row.totalQuantity }} {{ row.stockUnit }}</span></template></el-table-column>
        <el-table-column label="状态" width="100"><template #default="{ row }"><el-tag :type="row.status==='ACTIVE'?'success':'info'">{{ statusLabels[row.status] || row.status }}</el-tag></template></el-table-column>
        <el-table-column label="操作" width="100" fixed="right"><template #default="{ row }"><el-button v-if="row.status==='ACTIVE'" link type="danger" @click="reverse(row)">撤销</el-button></template></el-table-column>
      </el-table>
      <el-empty v-if="!loading && rows.length===0" description="还没有消耗记录"><el-button type="primary" @click="openCreate">记录第一次消耗</el-button></el-empty>
      <el-pagination v-if="meta.total>0" style="margin-top:16px;justify-content:flex-end" layout="total, prev, pager, next" :total="meta.total" :page-size="meta.pageSize" :current-page="meta.page" @current-change="load" />
    </section>

    <el-dialog v-model="dialogVisible" title="新增材料消耗" width="620px">
      <el-form label-position="top"><div class="form-grid">
        <el-form-item label="项目" required><el-select v-model="form.projectId" filterable style="width:100%"><el-option v-for="project in projects" :key="project.id" :value="project.id" :label="project.name" /></el-select></el-form-item>
        <el-form-item label="批次" required><el-select v-model="form.batchId" filterable style="width:100%"><el-option v-for="batch in batches.filter(item => item.remainingQuantity !== '0.000000')" :key="batch.id" :value="batch.id" :label="`${batch.materialName} · ${batch.batchCode || batch.id.slice(0,8)} · ${batch.remainingQuantity}${batch.stockUnit}`" /></el-select></el-form-item>
        <el-form-item label="对应材料需求"><el-select v-model="form.projectRequirementId" clearable style="width:100%" placeholder="可选"><el-option v-for="req in requirements" :key="req.id" :value="req.id" :label="`${req.materialName} · 计划 ${req.requiredQuantity}${req.stockUnit}`" /></el-select></el-form-item>
        <el-form-item label="消耗时间"><el-date-picker v-model="form.consumedAt" type="datetime" value-format="YYYY-MM-DDTHH:mm:ss" style="width:100%" /></el-form-item>
        <el-form-item label="实际使用数量" required><el-input v-model="form.usedQuantity" /></el-form-item>
        <el-form-item label="损耗数量"><el-input v-model="form.wasteQuantity" /></el-form-item>
        <el-form-item label="单位"><el-select v-model="form.unit" style="width:100%"><el-option v-for="unit in ['g','kg','ml','l','mm','cm','m','m2','pcs']" :key="unit" :value="unit" :label="unit" /></el-select></el-form-item>
        <el-form-item label="用途"><el-input v-model="form.purpose" /></el-form-item>
        <el-form-item label="备注" class="full"><el-input v-model="form.notes" type="textarea" :rows="3" /></el-form-item>
      </div></el-form>
      <template #footer><el-button @click="dialogVisible=false">取消</el-button><el-button type="primary" :loading="saving" @click="submit">确认扣减库存</el-button></template>
    </el-dialog>
  </div>
</template>
