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
const form = reactive({
  name: "",
  code: "",
  craftTypes: [] as string[],
  subtype: "",
  stockUnit: "g",
  lowStockThreshold: "",
  defaultColorName: "",
  defaultColorHex: "",
  tagsText: "",
  notes: ""
});

async function load() {
  if (!editing.value) return;
  try {
    const response = await request<{ data: any }>(`/materials/${route.params.id}`);
    const m = response.data;
    Object.assign(form, {
      name: m.name,
      code: m.code || "",
      craftTypes: m.craftTypes,
      subtype: m.subtype || "",
      stockUnit: m.stockUnit,
      lowStockThreshold: m.lowStockThreshold || "",
      defaultColorName: m.defaultColorName || "",
      defaultColorHex: m.defaultColorHex || "",
      tagsText: m.tags?.join("，") || "",
      notes: m.notes || ""
    });
    version.value = m.version;
  } catch (error) {
    ElMessage.error(error instanceof ApiError ? error.message : "材料加载失败");
  }
}

async function submit() {
  if (!form.name.trim() || form.craftTypes.length === 0) {
    ElMessage.error("请填写材料名称并至少选择一种工艺");
    return;
  }
  saving.value = true;
  try {
    const body = {
      name: form.name,
      code: form.code || null,
      craftTypes: form.craftTypes,
      subtype: form.subtype || null,
      stockUnit: form.stockUnit,
      lowStockThreshold: form.lowStockThreshold || null,
      defaultColorName: form.defaultColorName || null,
      defaultColorHex: form.defaultColorHex || null,
      tags: form.tagsText.split(/[,，]/).map((item) => item.trim()).filter(Boolean),
      notes: form.notes || null,
      ...(editing.value ? { version: version.value } : {})
    };
    const response = await request<{ data: { id: string } }>(editing.value ? `/materials/${route.params.id}` : "/materials", {
      method: editing.value ? "PATCH" : "POST",
      body
    });
    ElMessage.success(editing.value ? "材料已更新" : "材料已建立");
    await router.push(`/materials/${response.data.id}`);
  } catch (error) {
    ElMessage.error(error instanceof ApiError ? error.message : "保存失败");
  } finally {
    saving.value = false;
  }
}

onMounted(load);
</script>

<template>
  <div>
    <header class="page-header">
      <div><h1>{{ editing ? "编辑材料" : "新建材料" }}</h1><p>库存单位建立后，一旦有批次便不能修改，避免历史数量失真。</p></div>
      <el-button @click="router.back()">返回</el-button>
    </header>
    <section class="panel">
      <el-form label-position="top">
        <div class="form-grid">
          <el-form-item label="材料名称" required><el-input v-model="form.name" maxlength="120" /></el-form-item>
          <el-form-item label="材料编码"><el-input v-model="form.code" maxlength="64" placeholder="可选，例如 DYE-SUMU" /></el-form-item>
          <el-form-item label="适用工艺" required>
            <el-select v-model="form.craftTypes" multiple style="width: 100%">
              <el-option v-for="(label, value) in craftTypeLabels" :key="value" :value="value" :label="label" />
            </el-select>
          </el-form-item>
          <el-form-item label="细分类型"><el-input v-model="form.subtype" maxlength="80" placeholder="例如：天然染料、胡桃木、陶泥" /></el-form-item>
          <el-form-item label="库存单位" required>
            <el-select v-model="form.stockUnit" style="width: 100%">
              <el-option v-for="unit in ['g','kg','ml','l','mm','cm','m','m2','pcs']" :key="unit" :value="unit" :label="unit" />
            </el-select>
          </el-form-item>
          <el-form-item label="低库存阈值"><el-input v-model="form.lowStockThreshold" placeholder="留空表示不预警，例如 200" /></el-form-item>
          <el-form-item label="默认颜色名称"><el-input v-model="form.defaultColorName" maxlength="80" /></el-form-item>
          <el-form-item label="默认颜色值">
            <div style="display:flex; gap:10px; width:100%"><el-color-picker v-model="form.defaultColorHex" /><el-input v-model="form.defaultColorHex" placeholder="#RRGGBB" /></div>
          </el-form-item>
          <el-form-item label="标签" class="full"><el-input v-model="form.tagsText" placeholder="用逗号分隔，例如：天然，防水，常用" /></el-form-item>
          <el-form-item label="备注" class="full"><el-input v-model="form.notes" type="textarea" :rows="4" maxlength="5000" show-word-limit /></el-form-item>
        </div>
        <el-button type="primary" size="large" :loading="saving" @click="submit">{{ editing ? "保存修改" : "建立材料" }}</el-button>
      </el-form>
    </section>
  </div>
</template>
