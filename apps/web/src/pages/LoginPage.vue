<script setup lang="ts">
import { reactive, ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import { ElMessage } from "element-plus";
import { useAuthStore } from "@/stores/auth";
import { ApiError } from "@/lib/api";

const route = useRoute();
const router = useRouter();
const auth = useAuthStore();
const loading = ref(false);
const form = reactive({ password: "" });

async function submit() {
  loading.value = true;
  try {
    await auth.login(form.password);
    await router.push("/");
  } catch (error) {
    ElMessage.error(error instanceof ApiError ? error.message : "登录失败");
  } finally {
    loading.value = false;
  }
}
</script>

<template>
  <main class="auth-page">
    <section class="auth-card">
      <div class="brand-mark" style="margin-bottom: 18px">材</div>
      <h1>欢迎回来</h1>
      <p>登录后查看真实库存、项目消耗和颜色变化记录。</p>
      <el-alert v-if="route.query.offline" title="暂时无法连接 API，请确认服务已启动后重试。" type="warning" :closable="false" show-icon style="margin-bottom:16px" />
      <el-form label-position="top" @submit.prevent="submit">
        <el-form-item label="操作员">
          <el-input :model-value="auth.user?.displayName || '工作区操作员'" disabled />
        </el-form-item>
        <el-form-item label="密码">
          <el-input v-model="form.password" type="password" show-password @keyup.enter="submit" />
        </el-form-item>
        <el-button type="primary" size="large" style="width: 100%" :loading="loading" @click="submit">登录</el-button>
      </el-form>
    </section>
  </main>
</template>
