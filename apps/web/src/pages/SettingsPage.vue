<script setup lang="ts">
import { reactive, ref } from "vue";
import { useRouter } from "vue-router";
import { ElMessage } from "element-plus";
import { request, ApiError, download } from "@/lib/api";
import { useAuthStore } from "@/stores/auth";

const router = useRouter();
const auth = useAuthStore();
const saving = ref(false);
const form = reactive({ currentPassword: "", newPassword: "", confirmPassword: "" });
async function exportFile(path: string) {
  try {
    await download(path);
  } catch (error) {
    ElMessage.error(error instanceof ApiError ? error.message : "导出失败");
  }
}
async function changePassword() {
  if (form.newPassword !== form.confirmPassword) { ElMessage.error("两次输入的新密码不一致"); return; }
  saving.value = true;
  try {
    await request<void>("/auth/password", { method: "POST", body: { currentPassword: form.currentPassword, newPassword: form.newPassword } });
    auth.user = null;
    ElMessage.success("密码已修改，请重新登录");
    await router.push("/login");
  } catch (error) { ElMessage.error(error instanceof ApiError ? error.message : "密码修改失败"); }
  finally { saving.value = false; }
}
</script>

<template>
  <div>
    <header class="page-header"><div><h1>设置与数据</h1><p>导出真实工作区数据，或更新操作员密码。</p></div></header>
    <div class="two-column">
      <section class="panel">
        <h2>数据导出</h2>
        <p class="muted">导出内容来自 PostgreSQL 当前数据，不生成任何占位数据。</p>
        <div style="display:flex;gap:10px;flex-wrap:wrap">
          <el-button @click="exportFile('/exports/materials.csv')">导出材料 CSV</el-button>
          <el-button @click="exportFile('/exports/batches.csv')">导出批次 CSV</el-button>
          <el-button type="primary" @click="exportFile('/exports/workspace.json')">导出完整工作区 JSON</el-button>
        </div>
        <h3 style="margin-top:28px">运维说明</h3>
        <p class="muted">应定期备份 PostgreSQL 数据库和附件目录。生产环境必须使用强密码、HTTPS 和持久化存储。</p>
      </section>
      <section class="panel">
        <h2>修改密码</h2>
        <el-form label-position="top">
          <el-form-item label="当前密码"><el-input v-model="form.currentPassword" type="password" show-password /></el-form-item>
          <el-form-item label="新密码"><el-input v-model="form.newPassword" type="password" show-password placeholder="至少 10 位" /></el-form-item>
          <el-form-item label="确认新密码"><el-input v-model="form.confirmPassword" type="password" show-password /></el-form-item>
          <el-button type="primary" :loading="saving" @click="changePassword">修改密码</el-button>
        </el-form>
      </section>
    </div>
  </div>
</template>
