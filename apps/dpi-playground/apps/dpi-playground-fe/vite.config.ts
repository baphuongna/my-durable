import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
const sdk = fileURLToPath(new URL("../../../dpi-sdk/src", import.meta.url));
const version = JSON.parse(readFileSync(fileURLToPath(new URL("../../../../package.json", import.meta.url)), "utf8")).version;

export default defineConfig({
  define: { __DPI_BUILD__: JSON.stringify(version) },
  root: fileURLToPath(new URL(".", import.meta.url)),
  plugins: [vue()],
  resolve: { alias: { "@sdk": sdk } },
  server: {
    host: "127.0.0.1",
    fs: { allow: [fileURLToPath(new URL("../../../..", import.meta.url))] },
  },
  build: { outDir: "dist", emptyOutDir: true },
});
