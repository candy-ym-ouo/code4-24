<script setup lang="ts">
import { onMounted, reactive, ref } from "vue";
import { ElMessage, ElMessageBox } from "element-plus";
import { request, ApiError } from "@/lib/api";
import type { ApiMeta, Source } from "@/types";

const loading = ref(false);
const saving = ref(false);
const dialogVisible = ref(false);
const editingId = ref<string | null>(null);
const rows = ref<Source[]>([]);
const meta = reactive<ApiMeta>({ page: 1, pageSize: 20, total: 0, totalPages: 0 });
const filters = reactive({ q: "", type: "" });
const form = reactive({ name: "", type: "PURCHASED", contactName: "", contactPhone: "", contactEmail: "", address: "", notes: "" });
const typeLabels: Record<string, string> = { PURCHASED: "购买", GIFTED: "获赠", SELF_MADE: "自制", SALVAGED: "回收/捡拾", OTHER: "其他" };

async function load(page = 1) {
  loading.value = true;
  try {
    const params = new URLSearchParams({ page: String(page), pageSize: "20" });
    for (const [key, value] of Object.entries(filters)) if (value) params.set(key, value);
    const response = await request<{ data: Source[]; meta: ApiMeta }>(`/sources?${params}`);
    rows.value = response.data;
    Object.assign(meta, response.meta);
  } catch (error) {
    ElMessage.error(error instanceof ApiError ? error.message : "来源加载失败");
  } finally { loading.value = false; }
}

function openCreate() {
  editingId.value = null;
  Object.assign(form, { name: "", type: "PURCHASED", contactName: "", contactPhone: "", contactEmail: "", address: "", notes: "" });
  dialogVisible.value = true;
}
function openEdit(row: Source) {
  editingId.value = row.id;
  Object.assign(form, { name: row.name, type: row.type, contactName: row.contactName || "", contactPhone: row.contactPhone || "", contactEmail: row.contactEmail || "", address: row.address || "", notes: row.notes || "" });
  dialogVisible.value = true;
}
async function save() {
  saving.value = true;
  try {
    await request(editingId.value ? `/sources/${editingId.value}` : "/sources", { method: editingId.value ? "PATCH" : "POST", body: form });
    ElMessage.success(editingId.value ? "来源已更新" : "来源已建立");
    dialogVisible.value = false;
    await load(meta.page);
  } catch (error) { ElMessage.error(error instanceof ApiError ? error.message : "保存失败"); }
  finally { saving.value = false; }
}
async function archive(row: Source) {
  try {
    await ElMessageBox.confirm(`确认归档来源“${row.name}”？`, "归档来源", { type: "warning" });
    await request(`/sources/${row.id}/archive`, { method: "POST" });
    await load(meta.page);
  } catch (error: any) {
    if (error !== "cancel" && error !== "close") ElMessage.error(error instanceof ApiError ? error.message : "归档失败");
  }
}
onMounted(() => load());
</script>

<template>
  <div>
    <header class="page-header"><div><h1>来源管理</h1><p>记录材料从哪里来，以便批次追溯。</p></div><el-button type="primary" @click="openCreate">新增来源</el-button></header>
    <section class="toolbar">
      <el-form :inline="true" @submit.prevent="load(1)">
        <el-form-item label="关键词"><el-input v-model="filters.q" clearable @keyup.enter="load(1)" /></el-form-item>
        <el-form-item label="类型"><el-select v-model="filters.type" clearable style="width:140px"><el-option v-for="(label,value) in typeLabels" :key="value" :value="value" :label="label" /></el-select></el-form-item>
        <el-form-item><el-button type="primary" @click="load(1)">搜索</el-button></el-form-item>
      </el-form>
    </section>
    <section class="panel">
      <el-table v-loading="loading" :data="rows">
        <el-table-column label="来源" min-width="180"><template #default="{ row }"><router-link :to="`/sources/${row.id}`"><strong>{{ row.name }}</strong></router-link></template></el-table-column>
        <el-table-column label="类型" width="120"><template #default="{ row }">{{ typeLabels[row.type] || row.type }}</template></el-table-column>
        <el-table-column label="联系人" min-width="150"><template #default="{ row }">{{ row.contactName || "未记录" }}<div class="muted">{{ row.contactPhone || row.contactEmail || "" }}</div></template></el-table-column>
        <el-table-column label="关联批次" prop="batchCount" width="100" />
        <el-table-column label="有库存批次" prop="activeBatchCount" width="110" />
        <el-table-column label="操作" width="150" fixed="right"><template #default="{ row }"><el-button link type="primary" @click="openEdit(row)">编辑</el-button><el-button link type="danger" @click="archive(row)">归档</el-button></template></el-table-column>
      </el-table>
      <el-empty v-if="!loading && rows.length===0" description="还没有来源记录" />
      <el-pagination v-if="meta.total>0" style="margin-top:16px;justify-content:flex-end" layout="total, prev, pager, next" :total="meta.total" :page-size="meta.pageSize" :current-page="meta.page" @current-change="load" />
    </section>
    <el-dialog v-model="dialogVisible" :title="editingId ? '编辑来源' : '新增来源'" width="620px">
      <el-form label-position="top"><div class="form-grid">
        <el-form-item label="来源名称" required><el-input v-model="form.name" /></el-form-item>
        <el-form-item label="来源类型"><el-select v-model="form.type" style="width:100%"><el-option v-for="(label,value) in typeLabels" :key="value" :value="value" :label="label" /></el-select></el-form-item>
        <el-form-item label="联系人"><el-input v-model="form.contactName" /></el-form-item>
        <el-form-item label="联系电话"><el-input v-model="form.contactPhone" /></el-form-item>
        <el-form-item label="联系邮箱"><el-input v-model="form.contactEmail" /></el-form-item>
        <el-form-item label="地址"><el-input v-model="form.address" /></el-form-item>
        <el-form-item label="备注" class="full"><el-input v-model="form.notes" type="textarea" :rows="3" /></el-form-item>
      </div></el-form>
      <template #footer><el-button @click="dialogVisible=false">取消</el-button><el-button type="primary" :loading="saving" @click="save">保存</el-button></template>
    </el-dialog>
  </div>
</template>
