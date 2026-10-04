import { defineConfig } from "vite";
import { resolve } from "node:path";

// Nooky Desktop. No audio files: sounds are synthesised (src/core/sound.ts).
export default defineConfig({
  clearScreen: false,
  server: { port: 1420, strictPort: true, host: "127.0.0.1" },
  envPrefix: ["VITE_", "TAURI_ENV_"],
  build: {
    // WebView2 (Windows) and WKWebView on macOS 12+ (Safari 15).
    target: ["chrome110", "safari15"],
    minify: "esbuild",
    sourcemap: false,
    emptyOutDir: true,
    rollupOptions: {
      input: {
        island: resolve(__dirname, "index.html"),
        settings: resolve(__dirname, "settings.html"),
      },
    },
  },
});
