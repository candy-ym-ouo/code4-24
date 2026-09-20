<script setup lang="ts">
import { onMounted, ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import { ElMessage, ElMessageBox } from "element-plus";
import { request, ApiError } from "@/lib/api";
import { craftTypeLabels, statusLabels, type Material } from "@/types";

const route = useRoute();
const router = useRouter();
const loading = ref(true);
const material = ref<(Material & { batches: any[] }) | null>(null);

async function load() {
  loading.value = true;
  try {
    const response = await request<{ data: Material & { batches: any[] } }>(`/materials/${route.params.id}`);
    material.value = response.data;
  } catch (error) {
    ElMessage.error(error instanceof ApiError ? error.message : "材料加载失败");
  } finally {
    loading.value = false;
  }
}

async function archive() {
  try {
    await ElMessageBox.confirm("归档后材料不会出现在新建记录中，但历史仍保留。仅在无正库存时允许归档。", "确认归档", { type: "warning" });
    await request(`/materials/${route.params.id}/archive`, { method: "POST" });
    ElMessage.success("材料已归档");
    await router.push("/materials");
  } catch (error: any) {
    if (error === "cancel" || error === "close") return;
    ElMessage.error(error instanceof ApiError ? error.message : "归档失败");
  }
}

onMounted(load);
</script>

<template>
  <div v-loading="loading">
    <template v-if="material">
      <header class="page-header">
        <div><h1>{{ material.name }}</h1><p>{{ material.code || "无材料编码" }} · {{ material.subtype || "未分类" }}</p></div>
        <div>
          <el-button v-if="!material.archivedAt" @click="router.push(`/materials/${material.id}/edit`)">编辑</el-button>
          <el-button type="primary" @click="router.push({ path: '/batches/new', query: { materialId: material.id } })">新批次入库</el-button>
          <el-button v-if="!material.archivedAt" type="danger" plain @click="archive">归档</el-button>
        </div>
      </header>
      <section class="stat-grid">
        <article class="stat-card"><small>当前聚合库存</small><strong>{{ material.remainingQuantity }} {{ material.stockUnit }}</strong></article>
        <article class="stat-card"><small>有效批次</small><strong>{{ material.batchCount }}</strong></article>
        <article class="stat-card"><small>低库存阈值</small><strong>{{ material.lowStockThreshold || "未设置" }}</strong></article>
      </section>
      <section class="panel" style="margin-top: 16px">
        <h2>材料档案</h2>
        <el-descriptions :column="3" border>
          <el-descriptions-item label="适用工艺"><el-tag v-for="type in material.craftTypes" :key="type" size="small" style="margin-right:4px">{{ craftTypeLabels[type] || type }}</el-tag></el-descriptions-item>
          <el-descriptions-item label="默认颜色"><span v-if="material.defaultColorHex" class="color-dot" :style="{ background: material.defaultColorHex }" />{{ material.defaultColorName || "未设置" }}</el-descriptions-item>
          <el-descriptions-item label="库存单位">{{ material.stockUnit }}</el-descriptions-item>
          <el-descriptions-item label="标签" :span="2">{{ material.tags?.join("、") || "无" }}</el-descriptions-item>
          <el-descriptions-item label="状态">{{ material.archivedAt ? "已归档" : "使用中" }}</el-descriptions-item>
          <el-descriptions-item label="备注" :span="3">{{ material.notes || "无" }}</el-descriptions-item>
        </el-descriptions>
      </section>
      <section class="panel">
        <h2>批次明细</h2>
        <el-table :data="material.batches">
          <el-table-column label="批次">
            <template #default="{ row }"><router-link :to="`/batches/${row.id}`">{{ row.batchCode || "无批次号" }}</router-link><div class="muted">{{ row.sourceName || "来源不明" }} · {{ row.locationName || "未指定位置" }}</div></template>
          </el-table-column>
          <el-table-column label="剩余/初始" width="180"><template #default="{ row }"><span class="amount">{{ row.remainingQuantity }} / {{ row.initialQuantity }} {{ row.stockUnit }}</span></template></el-table-column>
          <el-table-column label="当前颜色" width="140"><template #default="{ row }"><span v-if="row.currentColorHex" class="color-dot" :style="{ background: row.currentColorHex }" />{{ row.currentColorName || "未记录" }}</template></el-table-column>
          <el-table-column label="入库日期" prop="receivedAt" width="120" />
          <el-table-column label="状态" width="100"><template #default="{ row }"><el-tag>{{ statusLabels[row.status] || row.status }}</el-tag></template></el-table-column>
        </el-table>
        <el-empty v-if="material.batches.length === 0" description="该材料还没有批次">
          <el-button type="primary" @click="router.push({ path: '/batches/new', query: { materialId: material.id } })">录入第一批材料</el-button>
        </el-empty>
      </section>
    </template>
  </div>
</template>
