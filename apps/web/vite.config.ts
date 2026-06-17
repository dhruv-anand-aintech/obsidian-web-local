import path from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";

const currentDir = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const helperPort = Number(env.OBSIDIAN_WEB_LOCAL_PORT ?? "3001");
  const webPort = Number(env.OBSIDIAN_WEB_LOCAL_WEB_PORT ?? "5173");

  return {
    plugins: [react()],
    resolve: {
      alias: {
        "@shared": path.resolve(currentDir, "../../packages/shared/src")
      }
    },
    server: {
      host: "127.0.0.1",
      port: webPort,
      proxy: {
        "/api": {
          target: `http://127.0.0.1:${helperPort}`,
          changeOrigin: true
        }
      }
    }
  };
});
