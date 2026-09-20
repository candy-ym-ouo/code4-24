<script setup lang="ts">
import { onMounted, reactive, ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import { ElMessage, ElMessageBox } from "element-plus";
import { request, ApiError } from "@/lib/api";
import { movementLabels, statusLabels, type Project } from "@/types";
import { createIdempotencyKey } from "@/lib/idempotency";
import { localDateTimeValue } from "@/lib/dates";
import AttachmentPanel from "@/components/AttachmentPanel.vue";

const route = useRoute();
const router = useRouter();
const loading = ref(true);
const saving = ref(false);
const batch = ref<any>(null);
const projects = ref<Project[]>([]);
const adjustmentVisible = ref(false);
const colorVisible = ref(false);
const adjustment = reactive({ direction: "OUT", quantity: "", unit: "", reason: "" });
const colorForm = reactive({ projectId: "", changeType: "OTHER", afterColorName: "", afterColorHex: "", affectedQuantity: "", unit: "", occurredAt: localDateTimeValue(), environmentNotes: "", notes: "" });

async function load() {
  loading.value = true;
  try {
    const [response, projectResponse] = await Promise.all([
      request<{ data: any }>(`/batches/${route.params.id}`),
      request<{ data: Project[] }>("/projects?pageSize=100")
    ]);
    batch.value = response.data;
    projects.value = projectResponse.data.filter((project) => ["PLANNED", "IN_PROGRESS", "COMPLETED"].includes(project.status));
    adjustment.unit = response.data.stockUnit;
    colorForm.unit = response.data.stockUnit;
  } catch (error) {
    ElMessage.error(error instanceof ApiError ? error.message : "批次加载失败");
  } finally {
    loading.value = false;
  }
}

function openAdjustmentDialog() {
  Object.assign(adjustment, { direction: "OUT", quantity: "", unit: batch.value?.stockUnit || "", reason: "" });
  adjustmentVisible.value = true;
}

async function submitAdjustment() {
  if (!adjustment.quantity || adjustment.reason.trim().length < 3) {
    ElMessage.error("请填写调整数量和至少 3 个字的调整原因");
    return;
  }
  saving.value = true;
  try {
    await request(`/batches/${batch.value.id}/adjustments`, {
      method: "POST",
      headers: { "Idempotency-Key": createIdempotencyKey() },
      body: { ...adjustment, version: batch.value.version }
    });
    ElMessage.success("库存调整已入账");
    adjustmentVisible.value = false;
    Object.assign(adjustment, { direction: "OUT", quantity: "", reason: "" });
    await load();
  } catch (error) {
    ElMessage.error(error instanceof ApiError ? error.message : "库存调整失败");
  } finally {
    saving.value = false;
  }
}

function openColorDialog() {
  Object.assign(colorForm, {
    projectId: "",
    changeType: "OTHER",
    afterColorName: "",
    afterColorHex: "",
    affectedQuantity: "",
    unit: batch.value?.stockUnit || "",
    occurredAt: localDateTimeValue(),
    environmentNotes: "",
    notes: ""
  });
  colorVisible.value = true;
}

async function submitColor() {
  if (!colorForm.afterColorName.trim()) {
    ElMessage.error("请填写变化后的颜色名称");
    return;
  }
  if (!colorForm.occurredAt) {
    ElMessage.error("请选择颜色变化发生时间");
    return;
  }
  saving.value = true;
  try {
    const response = await request<{ data: { isCurrent: boolean } }>("/color-changes", {
      method: "POST",
      body: {
        batchId: batch.value.id,
        projectId: colorForm.projectId || null,
        changeType: colorForm.changeType,
        beforeColorName: batch.value.currentColorName,
        beforeColorHex: batch.value.currentColorHex,
        afterColorName: colorForm.afterColorName,
        afterColorHex: colorForm.afterColorHex || null,
        affectedQuantity: colorForm.affectedQuantity || null,
        unit: colorForm.affectedQuantity ? colorForm.unit : null,
        environmentNotes: colorForm.environmentNotes || null,
        occurredAt: new Date(colorForm.occurredAt).toISOString(),
        notes: colorForm.notes || null
      }
    });
    ElMessage.success(response.data.isCurrent ? "颜色变化已记录，当前颜色已更新" : "历史颜色已记录，当前颜色未改变");
    colorVisible.value = false;
    await load();
  } catch (error) {
    ElMessage.error(error instanceof ApiError ? error.message : "颜色记录失败");
  } finally {
    saving.value = false;
  }
}

async function archive() {
  try {
    await ElMessageBox.confirm("只有余额为 0 的批次可以归档，历史流水会保留。", "归档批次", { type: "warning" });
    await request(`/batches/${batch.value.id}/archive`, { method: "POST" });
    ElMessage.success("批次已归档");
    await router.push("/batches");
  } catch (error: any) {
    if (error === "cancel" || error === "close") return;
    ElMessage.error(error instanceof ApiError ? error.message : "归档失败");
  }
}

onMounted(load);
</script>

<template>
  <div v-loading="loading">
    <template v-if="batch">
      <header class="page-header">
        <div><h1>{{ batch.materialName }}</h1><p>{{ batch.batchCode || "无批次号" }} · {{ batch.sourceName || batch.sourceNote || "来源不明" }}</p></div>
        <div>
          <el-button v-if="batch.status === 'ACTIVE'" @click="router.push({ path: '/consumptions', query: { batchId: batch.id, create: '1' } })">记录消耗</el-button>
          <el-button v-if="batch.status !== 'ARCHIVED'" @click="openAdjustmentDialog()">库存调整</el-button>
          <el-button v-if="batch.status !== 'ARCHIVED'" type="primary" @click="openColorDialog()">记录颜色变化</el-button>
          <el-button v-if="batch.status === 'DEPLETED'" type="danger" plain @click="archive">归档</el-button>
        </div>
      </header>
      <section class="stat-grid">
        <article class="stat-card"><small>剩余数量</small><strong>{{ batch.remainingQuantity }} {{ batch.stockUnit }}</strong></article>
        <article class="stat-card"><small>初始数量</small><strong>{{ batch.initialQuantity }} {{ batch.stockUnit }}</strong></article>
        <article class="stat-card"><small>当前颜色</small><strong><span v-if="batch.currentColorHex" class="color-dot" :style="{ background: batch.currentColorHex }" />{{ batch.currentColorName || "未记录" }}</strong></article>
        <article class="stat-card"><small>批次状态</small><strong>{{ statusLabels[batch.status] || batch.status }}</strong></article>
      </section>
      <section class="panel" style="margin-top:16px">
        <h2>批次信息</h2>
        <el-descriptions :column="3" border>
          <el-descriptions-item label="材料"><router-link :to="`/materials/${batch.materialId}`">{{ batch.materialName }}</router-link></el-descriptions-item>
          <el-descriptions-item label="入库日期">{{ batch.receivedAt }}</el-descriptions-item>
          <el-descriptions-item label="有效期">{{ batch.expiryAt || "无" }}</el-descriptions-item>
          <el-descriptions-item label="存放位置">{{ batch.locationName || "未指定" }}</el-descriptions-item>
          <el-descriptions-item label="成本">{{ batch.totalCost ? `${batch.totalCost} ${batch.currency || ""}` : "未记录" }}</el-descriptions-item>
          <el-descriptions-item label="输入单位">{{ batch.entryUnit }}</el-descriptions-item>
          <el-descriptions-item label="备注" :span="3">{{ batch.notes || "无" }}</el-descriptions-item>
        </el-descriptions>
      </section>

      <AttachmentPanel owner-type="BATCH" :owner-id="batch.id" :attachments="batch.attachments" @changed="load" />

      <div class="two-column">
        <section class="panel">
          <h2>库存流水</h2>
          <el-table :data="batch.movements" size="small">
            <el-table-column label="时间" width="170"><template #default="{ row }">{{ new Date(row.createdAt).toLocaleString() }}</template></el-table-column>
            <el-table-column label="类型" width="100"><template #default="{ row }">{{ movementLabels[row.type] || row.type }}</template></el-table-column>
            <el-table-column label="变化" width="120"><template #default="{ row }"><span class="amount">{{ row.signedQuantity }} {{ row.stockUnit }}</span></template></el-table-column>
            <el-table-column label="结余" width="120"><template #default="{ row }">{{ row.beforeQuantity }} → {{ row.afterQuantity }}</template></el-table-column>
            <el-table-column label="原因" prop="reason" min-width="120" />
          </el-table>
        </section>
        <section class="panel">
          <h2>颜色时间线</h2>
          <el-timeline v-if="batch.colorChanges.length">
            <el-timeline-item v-for="item in batch.colorChanges" :key="item.id" :timestamp="new Date(item.occurredAt).toLocaleString()">
              <strong>{{ item.beforeColorName || "未记录" }} → {{ item.afterColorName }}</strong>
              <div><span v-if="item.afterColorHex" class="color-dot" :style="{ background: item.afterColorHex }" />{{ item.notes || "无备注" }}</div>
            </el-timeline-item>
          </el-timeline>
          <el-empty v-else description="还没有颜色变化记录" />
        </section>
      </div>
    </template>

    <el-dialog v-model="adjustmentVisible" title="库存调整" width="520px">
      <el-form label-position="top">
        <el-form-item label="方向"><el-radio-group v-model="adjustment.direction"><el-radio value="IN">盘增</el-radio><el-radio value="OUT">盘减</el-radio></el-radio-group></el-form-item>
        <el-form-item label="数量"><el-input v-model="adjustment.quantity" /></el-form-item>
        <el-form-item label="单位"><el-select v-model="adjustment.unit" style="width:100%"><el-option v-for="unit in ['g','kg','ml','l','mm','cm','m','m2','pcs']" :key="unit" :value="unit" :label="unit" /></el-select></el-form-item>
        <el-form-item label="原因" required><el-input v-model="adjustment.reason" type="textarea" placeholder="例如：月末盘点发现密封袋破损" /></el-form-item>
      </el-form>
      <template #footer><el-button @click="adjustmentVisible = false">取消</el-button><el-button type="primary" :loading="saving" @click="submitAdjustment">确认调整</el-button></template>
    </el-dialog>

    <el-dialog v-model="colorVisible" title="记录颜色变化" width="600px">
      <el-alert title="颜色变化只记录外观演变，不会自动改变库存数量。" type="info" show-icon :closable="false" style="margin-bottom:16px" />
      <el-form label-position="top">
        <div class="form-grid">
          <el-form-item label="关联项目（可选）"><el-select v-model="colorForm.projectId" clearable filterable style="width:100%"><el-option v-for="project in projects" :key="project.id" :value="project.id" :label="project.name" /></el-select></el-form-item>
          <el-form-item label="发生时间"><el-date-picker v-model="colorForm.occurredAt" type="datetime" value-format="YYYY-MM-DDTHH:mm:ss" style="width:100%" /></el-form-item>
          <el-form-item label="变化类型"><el-select v-model="colorForm.changeType" style="width:100%"><el-option value="OXIDATION" label="氧化" /><el-option value="DYE_BATH" label="染色" /><el-option value="FINISHING" label="表面处理" /><el-option value="GLAZE" label="施釉" /><el-option value="PATINA" label="做旧/锈化" /><el-option value="WEATHERING" label="自然风化" /><el-option value="MIXING" label="混合" /><el-option value="OTHER" label="其他" /></el-select></el-form-item>
          <el-form-item label="影响数量（可选）"><el-input v-model="colorForm.affectedQuantity" /></el-form-item>
          <el-form-item label="变化后颜色名称" required><el-input v-model="colorForm.afterColorName" /></el-form-item>
          <el-form-item label="变化后颜色值"><div style="display:flex;gap:10px;width:100%"><el-color-picker v-model="colorForm.afterColorHex" /><el-input v-model="colorForm.afterColorHex" /></div></el-form-item>
          <el-form-item label="环境说明" class="full"><el-input v-model="colorForm.environmentNotes" placeholder="温度、湿度、pH 或工艺条件" /></el-form-item>
          <el-form-item label="备注" class="full"><el-input v-model="colorForm.notes" type="textarea" :rows="3" /></el-form-item>
        </div>
      </el-form>
      <template #footer><el-button @click="colorVisible = false">取消</el-button><el-button type="primary" :loading="saving" @click="submitColor">保存记录</el-button></template>
    </el-dialog>
  </div>
</template>
