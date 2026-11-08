import { defineConfig } from "vite";

// w.js, small and with no dependencies: the server wraps it per site and calls OALC.start() with its settings.
export default defineConfig({
  root: import.meta.dirname,
  build: {
    outDir: "../dist/widget",
    emptyOutDir: true,
    target: "es2019",
    lib: { entry: "w.ts", formats: ["iife"], name: "OALC", fileName: () => "w.js" },
  },
});
