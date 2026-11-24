import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(async () => ({
  plugins: [react()],
  clearScreen: false,
  define: {
    /* 真材质档在**构建期**定，不在运行期嗅探。
       Tauri 的 macOS 包（transparent + windowEffects）都在 macOS runner 上编，
       Windows 包在 Windows 上编，所以 `process.platform` 在这里等价于「产物跑在
       哪个平台」，而不是「谁的机器在打包」。
       之前用 UA 判 Macintosh 是运行期判断：判错就静默退回不透明，用户看到的是
       「材质没开」，日志里什么也没有。构建期常量判错的话，Windows 包会编译不通过
       任何一条与材质相关的断言，不会静默。 */
    __MATERIAL__: JSON.stringify(process.platform === "darwin" ? "vibrancy" : ""),
  },
  server: {
    port: 1420,
    strictPort: true,
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks: undefined,
      },
    },
  },
}));
