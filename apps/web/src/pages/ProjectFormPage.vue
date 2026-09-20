<script setup lang="ts">
import { computed, onMounted, reactive, ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import { ElMessage } from "element-plus";
import { request, ApiError } from "@/lib/api";
import { craftTypeLabels } from "@/types";

const route = useRoute();
const router = useRouter();
const editing = computed(() => Boolean(route.params.id));
const saving = ref(false);
const version = ref(1);
const form = reactive({ name: "", craftType: "DYEING", status: "PLANNED", startDate: "", dueDate: "", description: "", targetColorName: "", targetColorHex: "", tagsText: "" });

async function load() {
  if (!editing.value) return;
  try {
    const response = await request<{ data: any }>(`/projects/${route.params.id}`);
    const project = response.data;
    Object.assign(form, { name: project.name, craftType: project.craftType, status: project.status, startDate: project.startDate || "", dueDate: project.dueDate || "", description: project.description || "", targetColorName: project.targetColorName || "", targetColorHex: project.targetColorHex || "", tagsText: project.tags?.join("，") || "" });
    version.value = project.version;
  } catch (error) {
    ElMessage.error(error instanceof ApiError ? error.message : "项目加载失败");
    await router.push("/projects");
  }
}
async function submit() {
  saving.value = true;
  try {
    const body = { ...form, startDate: form.startDate || null, dueDate: form.dueDate || null, description: form.description || null, targetColorName: form.targetColorName || null, targetColorHex: form.targetColorHex || null, tags: form.tagsText.split(/[,，]/).map((x) => x.trim()).filter(Boolean), ...(editing.value ? { version: version.value } : {}) };
    const response = await request<{ data: { id: string } }>(editing.value ? `/projects/${route.params.id}` : "/projects", { method: editing.value ? "PATCH" : "POST", body });
    ElMessage.success(editing.value ? "项目已更新" : "项目已建立");
    await router.push(`/projects/${response.data.id}`);
  } catch (error) { ElMessage.error(error instanceof ApiError ? error.message : "保存失败"); }
  finally { saving.value = false; }
}
onMounted(load);
</script>

<template>
  <div>
    <header class="page-header"><div><h1>{{ editing ? "编辑项目" : "新建项目" }}</h1><p>先定义项目，再添加计划用料和实际消耗。</p></div><el-button @click="router.back()">返回</el-button></header>
    <section class="panel"><el-form label-position="top"><div class="form-grid">
      <el-form-item label="项目名称" required><el-input v-model="form.name" /></el-form-item>
      <el-form-item label="主要工艺" required><el-select v-model="form.craftType" style="width:100%"><el-option v-for="(label,value) in craftTypeLabels" :key="value" :value="value" :label="label" /></el-select></el-form-item>
      <el-form-item label="状态"><el-select v-model="form.status" style="width:100%" :disabled="editing"><el-option value="PLANNED" label="计划中" /><el-option value="IN_PROGRESS" label="进行中" /><el-option value="COMPLETED" label="已完成" /></el-select></el-form-item>
      <el-form-item label="开始日期"><el-date-picker v-model="form.startDate" type="date" value-format="YYYY-MM-DD" style="width:100%" /></el-form-item>
      <el-form-item label="截止日期"><el-date-picker v-model="form.dueDate" type="date" value-format="YYYY-MM-DD" style="width:100%" /></el-form-item>
      <el-form-item label="目标颜色名称"><el-input v-model="form.targetColorName" /></el-form-item>
      <el-form-item label="目标颜色值"><div style="display:flex;gap:10px;width:100%"><el-color-picker v-model="form.targetColorHex" /><el-input v-model="form.targetColorHex" /></div></el-form-item>
      <el-form-item label="标签"><el-input v-model="form.tagsText" placeholder="用逗号分隔" /></el-form-item>
      <el-form-item label="项目说明" class="full"><el-input v-model="form.description" type="textarea" :rows="4" /></el-form-item>
    </div><el-button type="primary" size="large" :loading="saving" @click="submit">保存项目</el-button></el-form></section>
  </div>
</template>
