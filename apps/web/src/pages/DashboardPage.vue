<script setup lang="ts">
import { onMounted, ref } from "vue";
import { request, ApiError } from "@/lib/api";
import { movementLabels, craftTypeLabels } from "@/types";

type Dashboard = {
  summary: {
    materialCount: number;
    activeBatchCount: number;
    depletedBatchCount: number;
    activeProjectCount: number;
    consumptionCountThisMonth: number;
  };
  lowStock: Array<{ id: string; name: string; remainingQuantity: string; stockUnit: string; lowStockThreshold: string }>;
  expiring: Array<{ id: string; materialName: string; batchCode: string | null; expiryAt: string; remainingQuantity: string; stockUnit: string; daysRemaining: number }>;
  recentMovements: Array<{ id: string; type: string; signedQuantity: string; stockUnit: string; afterQuantity: string; createdAt: string; batchId: string; materialName: string; batchCode: string | null }>;
  activeProjects: Array<{ id: string; name: string; craftType: string; status: string; dueDate: string | null; requirementCount: number; consumptionCount: number }>;
  generatedAt: string;
};

const loading = ref(true);
const data = ref<Dashboard | null>(null);
const error = ref("");

async function load() {
  loading.value = true;
  error.value = "";
  try {
    const response = await request<{ data: Dashboard }>("/dashboard");
    data.value = response.data;
  } catch (err) {
    error.value = err instanceof ApiError ? err.message : "仪表盘加载失败";
  } finally {
    loading.value = false;
  }
}

onMounted(load);
</script>

<template>
  <div v-loading="loading">
    <header class="page-header">
      <div>
        <h1>仪表盘</h1>
        <p>所有统计直接来自当前库存流水、项目需求和实际消耗。</p>
      </div>
      <el-button @click="load">刷新数据</el-button>
    </header>
    <el-alert v-if="error" :title="error" type="error" show-icon closable @close="error = ''" />
    <template v-if="data">
      <section class="stat-grid">
        <article class="stat-card"><small>材料档案</small><strong>{{ data.summary.materialCount }}</strong></article>
        <article class="stat-card"><small>有库存批次</small><strong>{{ data.summary.activeBatchCount }}</strong></article>
        <article class="stat-card"><small>进行中项目</small><strong>{{ data.summary.activeProjectCount }}</strong></article>
        <article class="stat-card"><small>已耗尽批次</small><strong>{{ data.summary.depletedBatchCount }}</strong></article>
        <article class="stat-card"><small>本月消耗笔数</small><strong>{{ data.summary.consumptionCountThisMonth }}</strong></article>
      </section>

      <div class="two-column" style="margin-top: 16px">
        <section class="panel">
          <h2>最近库存流水</h2>
          <el-table v-if="data.recentMovements.length" :data="data.recentMovements" size="small">
            <el-table-column label="时间" width="170">
              <template #default="{ row }">{{ new Date(row.createdAt).toLocaleString() }}</template>
            </el-table-column>
            <el-table-column label="材料">
              <template #default="{ row }"><router-link :to="`/batches/${row.batchId}`">{{ row.materialName }}</router-link><div class="muted">{{ row.batchCode || "无批次号" }}</div></template>
            </el-table-column>
            <el-table-column label="动作" width="100"><template #default="{ row }">{{ movementLabels[row.type] || row.type }}</template></el-table-column>
            <el-table-column label="变化" width="120"><template #default="{ row }"><span class="amount">{{ row.signedQuantity }} {{ row.stockUnit }}</span></template></el-table-column>
            <el-table-column label="结余" width="120"><template #default="{ row }">{{ row.afterQuantity }} {{ row.stockUnit }}</template></el-table-column>
          </el-table>
          <el-empty v-else description="还没有库存流水" />
        </section>

        <section class="panel">
          <h2>低库存提醒</h2>
          <el-table v-if="data.lowStock.length" :data="data.lowStock" size="small">
            <el-table-column label="材料" prop="name" />
            <el-table-column label="剩余">
              <template #default="{ row }"><span class="amount">{{ row.remainingQuantity }} / {{ row.lowStockThreshold }} {{ row.stockUnit }}</span></template>
            </el-table-column>
          </el-table>
          <el-empty v-else description="暂无低库存材料" />
        </section>
      </div>

      <div class="two-column" style="margin-top: 16px">
        <section class="panel">
          <h2>进行中的项目</h2>
          <el-table v-if="data.activeProjects.length" :data="data.activeProjects">
            <el-table-column label="项目">
              <template #default="{ row }"><router-link :to="`/projects/${row.id}`">{{ row.name }}</router-link></template>
            </el-table-column>
            <el-table-column label="工艺" width="100"><template #default="{ row }">{{ craftTypeLabels[row.craftType] || row.craftType }}</template></el-table-column>
            <el-table-column label="需求" prop="requirementCount" width="80" />
            <el-table-column label="消耗笔数" prop="consumptionCount" width="100" />
            <el-table-column label="截止日期" prop="dueDate" width="120" />
          </el-table>
          <el-empty v-else description="暂无进行中的项目" />
        </section>
        <section class="panel">
          <h2>已过期或 30 天内到期</h2>
          <el-table v-if="data.expiring.length" :data="data.expiring" size="small">
            <el-table-column label="材料" prop="materialName" />
            <el-table-column label="批次" prop="batchCode" />
            <el-table-column label="到期" prop="expiryAt" width="110" />
          </el-table>
          <el-empty v-else description="暂无临期批次" />
        </section>
      </div>
      <p class="muted" style="font-size: 12px">生成时间：{{ new Date(data.generatedAt).toLocaleString() }}</p>
    </template>
  </div>
</template>
