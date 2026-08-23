import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";

export default defineConfig({
  plugins: [vue()],
  server: {
    port: 5173,
    // free-ports гарантирует, что 5173 свободен → фиксируем порт и не уезжаем на 5174
    strictPort: true,
    watch: {
      ignored: ["**/.browser-profile/**"],
    },
    proxy: {
      "/api": {
        target: "http://localhost:3001",
        changeOrigin: true,
      },
    },
  },
});
