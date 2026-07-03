import { solidStart } from "@solidjs/start/config";
import { nitroV2Plugin as nitro } from "@solidjs/vite-plugin-nitro-2";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [solidStart(), nitro()],
});
