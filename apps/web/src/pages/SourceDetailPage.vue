<script setup lang="ts">
import { onMounted, ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import { ElMessage } from "element-plus";
import { request, ApiError } from "@/lib/api";

const route = useRoute();
const router = useRouter();
const loading = ref(true);
const source = ref<any>(null);
const typeLabels: Record<string, string> = { PURCHASED: "购买", GIFTED: "获赠", SELF_MADE: "自制", SALVAGED: "回收/捡拾", OTHER: "其他" };

async function load() {
  loading.value = true;
  try { source.value = (await request<{ data: any }>(`/sources/${route.params.id}`)).data; }
  catch (error) { ElMessage.error(error instanceof ApiError ? error.message : "来源加载失败"); }
  finally { loading.value = false; }
}
onMounted(load);
</script>

<template>
  <div v-loading="loading">
    <template v-if="source">
      <header class="page-header"><div><h1>{{ source.name }}</h1><p>{{ typeLabels[source.type] || source.type }} · {{ source.archivedAt ? "已归档" : "使用中" }}</p></div><el-button @click="router.push('/sources')">返回来源列表</el-button></header>
      <section class="panel">
        <el-descriptions :column="3" border>
          <el-descriptions-item label="联系人">{{ source.contactName || "未记录" }}</el-descriptions-item>
          <el-descriptions-item label="联系电话">{{ source.contactPhone || "未记录" }}</el-descriptions-item>
          <el-descriptions-item label="联系邮箱">{{ source.contactEmail || "未记录" }}</el-descriptions-item>
          <el-descriptions-item label="地址" :span="3">{{ source.address || "未记录" }}</el-descriptions-item>
          <el-descriptions-item label="备注" :span="3">{{ source.notes || "无" }}</el-descriptions-item>
        </el-descriptions>
      </section>
      <section class="panel">
        <h2>关联批次</h2>
        <el-table :data="source.batches">
          <el-table-column label="材料"><template #default="{ row }"><router-link :to="`/materials/${row.materialId}`">{{ row.materialName }}</router-link></template></el-table-column>
          <el-table-column label="批次号"><template #default="{ row }"><router-link :to="`/batches/${row.id}`">{{ row.batchCode || "无批次号" }}</router-link></template></el-table-column>
          <el-table-column label="剩余量" width="150"><template #default="{ row }">{{ row.remainingQuantity }} {{ row.stockUnit }}</template></el-table-column>
          <el-table-column label="入库日期" prop="receivedAt" width="120" />
          <el-table-column label="状态" prop="status" width="110" />
        </el-table>
        <el-empty v-if="source.batches.length===0" description="该来源还没有关联批次" />
      </section>
    </template>
  </div>
</template>
