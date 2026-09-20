import { defineConfig, loadEnv } from "vite";
import vue from "@vitejs/plugin-vue";
import path from "node:path";

export default defineConfig(({ mode }) => {
  const rootEnv = loadEnv(mode, path.resolve(__dirname, "../.."), "");
  const apiPort = rootEnv.APP_PORT || "3000";
  return {
    plugins: [vue()],
    resolve: {
      alias: {
        "@": path.resolve(__dirname, "src")
      }
    },
    server: {
      port: 5173,
      proxy: {
        "/api": `http://127.0.0.1:${apiPort}`,
        "/health": `http://127.0.0.1:${apiPort}`
      }
    }
  };
});
