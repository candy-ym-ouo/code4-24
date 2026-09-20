import { defineStore } from "pinia";
import { request, ApiError } from "@/lib/api";

type User = { id: string; displayName: string };

export const useAuthStore = defineStore("auth", {
  state: () => ({
    initialized: false,
    loaded: false,
    user: null as User | null
  }),
  actions: {
    async bootstrap() {
      if (this.loaded) return;
      const status = await request<{ data: { initialized: boolean } }>("/setup/status");
      this.initialized = status.data.initialized;
      if (this.initialized) {
        try {
          const session = await request<{ data: User }>("/auth/me");
          this.user = session.data;
        } catch (error) {
          if (!(error instanceof ApiError) || error.status !== 401) throw error;
          this.user = null;
        }
      }
      this.loaded = true;
    },
    async setup(displayName: string, password: string) {
      const result = await request<{ data: User }>("/setup", { method: "POST", body: { displayName, password } });
      this.initialized = true;
      this.user = result.data;
    },
    async login(password: string) {
      const result = await request<{ data: User }>("/auth/login", { method: "POST", body: { password } });
      this.user = result.data;
    },
    async logout() {
      await request<void>("/auth/logout", { method: "POST" });
      this.user = null;
    }
  }
});
