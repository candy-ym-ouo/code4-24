<script setup lang="ts">
import { onMounted, reactive, ref } from "vue";
import { ElMessage, ElMessageBox } from "element-plus";
import { request, ApiError } from "@/lib/api";
import type { Location } from "@/types";

const loading = ref(false);
const saving = ref(false);
const dialogVisible = ref(false);
const editingId = ref<string | null>(null);
const rows = ref<Location[]>([]);
const form = reactive({ name: "", parentId: "", notes: "" });

async function load() {
  loading.value = true;
  try { rows.value = (await request<{ data: Location[] }>("/locations")).data; }
  catch (error) { ElMessage.error(error instanceof ApiError ? error.message : "位置加载失败"); }
  finally { loading.value = false; }
}
function openCreate() { editingId.value = null; Object.assign(form, { name: "", parentId: "", notes: "" }); dialogVisible.value = true; }
function openEdit(row: Location) { editingId.value = row.id; Object.assign(form, { name: row.name, parentId: row.parentId || "", notes: row.notes || "" }); dialogVisible.value = true; }
async function save() {
  saving.value = true;
  try {
    await request(editingId.value ? `/locations/${editingId.value}` : "/locations", { method: editingId.value ? "PATCH" : "POST", body: { ...form, parentId: form.parentId || null, notes: form.notes || null } });
    ElMessage.success("位置已保存"); dialogVisible.value = false; await load();
  } catch (error) { ElMessage.error(error instanceof ApiError ? error.message : "保存失败"); }
  finally { saving.value = false; }
}
async function archive(row: Location) {
  try {
    await ElMessageBox.confirm(`归档位置“${row.name}”？已有批次仍保留历史引用。`, "归档位置", { type: "warning" });
    await request(`/locations/${row.id}/archive`, { method: "POST" }); await load();
  } catch (error: any) { if (error !== "cancel" && error !== "close") ElMessage.error(error instanceof ApiError ? error.message : "归档失败"); }
}
onMounted(load);
</script>

<template>
  <div>
    <header class="page-header"><div><h1>存放位置</h1><p>建立架、柜、抽屉和房间层级，便于库存定位。</p></div><el-button type="primary" @click="openCreate">新增位置</el-button></header>
    <section class="panel">
      <el-table v-loading="loading" :data="rows">
        <el-table-column label="位置" prop="name" min-width="200" />
        <el-table-column label="上级位置"><template #default="{ row }">{{ rows.find(item => item.id === row.parentId)?.name || "顶级位置" }}</template></el-table-column>
        <el-table-column label="有效批次" prop="batchCount" width="100" />
        <el-table-column label="备注" prop="notes" min-width="180" />
        <el-table-column label="操作" width="150" fixed="right"><template #default="{ row }"><el-button link type="primary" @click="openEdit(row)">编辑</el-button><el-button link type="danger" @click="archive(row)">归档</el-button></template></el-table-column>
      </el-table>
      <el-empty v-if="!loading && rows.length===0" description="还没有存放位置" />
    </section>
    <el-dialog v-model="dialogVisible" :title="editingId ? '编辑位置' : '新增位置'" width="520px">
      <el-form label-position="top">
        <el-form-item label="位置名称" required><el-input v-model="form.name" /></el-form-item>
        <el-form-item label="上级位置"><el-select v-model="form.parentId" clearable style="width:100%"><el-option v-for="row in rows.filter(item => item.id !== editingId)" :key="row.id" :value="row.id" :label="row.name" /></el-select></el-form-item>
        <el-form-item label="备注"><el-input v-model="form.notes" type="textarea" :rows="3" /></el-form-item>
      </el-form>
      <template #footer><el-button @click="dialogVisible=false">取消</el-button><el-button type="primary" :loading="saving" @click="save">保存</el-button></template>
    </el-dialog>
  </div>
</template>
