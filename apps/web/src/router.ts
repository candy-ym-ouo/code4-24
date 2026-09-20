import { createRouter, createWebHistory } from "vue-router";
import { useAuthStore } from "@/stores/auth";

const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: "/setup", component: () => import("@/pages/SetupPage.vue"), meta: { public: true } },
    { path: "/login", component: () => import("@/pages/LoginPage.vue"), meta: { public: true } },
    { path: "/", component: () => import("@/pages/DashboardPage.vue") },
    { path: "/materials", component: () => import("@/pages/MaterialsPage.vue") },
    { path: "/materials/new", component: () => import("@/pages/MaterialFormPage.vue") },
    { path: "/materials/:id/edit", component: () => import("@/pages/MaterialFormPage.vue") },
    { path: "/materials/:id", component: () => import("@/pages/MaterialDetailPage.vue") },
    { path: "/batches", component: () => import("@/pages/BatchesPage.vue") },
    { path: "/batches/new", component: () => import("@/pages/BatchFormPage.vue") },
    { path: "/batches/:id", component: () => import("@/pages/BatchDetailPage.vue") },
    { path: "/sources", component: () => import("@/pages/SourcesPage.vue") },
    { path: "/sources/:id", component: () => import("@/pages/SourceDetailPage.vue") },
    { path: "/locations", component: () => import("@/pages/LocationsPage.vue") },
    { path: "/projects", component: () => import("@/pages/ProjectsPage.vue") },
    { path: "/projects/new", component: () => import("@/pages/ProjectFormPage.vue") },
    { path: "/projects/:id/edit", component: () => import("@/pages/ProjectFormPage.vue") },
    { path: "/projects/:id", component: () => import("@/pages/ProjectDetailPage.vue") },
    { path: "/consumptions", component: () => import("@/pages/ConsumptionsPage.vue") },
    { path: "/settings", component: () => import("@/pages/SettingsPage.vue") },
    { path: "/audit", component: () => import("@/pages/AuditPage.vue") },
    { path: "/:pathMatch(.*)*", redirect: "/" }
  ],
  scrollBehavior: () => ({ top: 0 })
});

router.beforeEach(async (to) => {
  const auth = useAuthStore();
  try {
    await auth.bootstrap();
  } catch {
    if (to.path !== "/login") return { path: "/login", query: { offline: "1" } };
    return true;
  }
  if (!auth.initialized && to.path !== "/setup") return "/setup";
  if (auth.initialized && !auth.user && !to.meta.public) return "/login";
  if (auth.user && (to.path === "/login" || to.path === "/setup")) return "/";
  if (!auth.user && to.path === "/setup" && auth.initialized) return "/login";
  return true;
});

export default router;
