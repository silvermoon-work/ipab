import { defineConfig } from "vite";
export default defineConfig({
  base: "./",
  resolve: { dedupe: ["react", "react-dom"] },
  build: { target: "es2022" },
});
