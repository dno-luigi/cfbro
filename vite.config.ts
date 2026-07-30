import { cloudflare } from "@cloudflare/vite-plugin";
import codemode from "@cloudflare/codemode/vite";
import agents from "agents/vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), agents(), codemode(), cloudflare(), tailwindcss()]
});
