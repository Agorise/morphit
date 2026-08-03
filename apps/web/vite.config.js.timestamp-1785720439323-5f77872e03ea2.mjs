// vite.config.js
import { sveltekit } from "file:///home/claude/morphit/morphit/node_modules/@sveltejs/kit/src/exports/vite/index.js";
import { defineConfig } from "file:///home/claude/morphit/morphit/node_modules/vite/dist/node/index.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
var __vite_injected_original_import_meta_url = "file:///home/claude/morphit/morphit/apps/web/vite.config.js";
var HERE = dirname(fileURLToPath(__vite_injected_original_import_meta_url));
var pkg = JSON.parse(readFileSync(resolve(HERE, "package.json"), "utf8"));
var vite_config_default = defineConfig({
  plugins: [sveltekit()],
  define: {
    // Batch J: bake the package.json version into the bundle so
    // the release-trust-anchor module can compare running vs
    // announced version.  Available throughout the app as
    // `__MORPHIT_VERSION__`.
    __MORPHIT_VERSION__: JSON.stringify(pkg.version)
  },
  build: {
    target: "es2022",
    minify: "esbuild",
    cssMinify: "lightningcss",
    sourcemap: false,
    reportCompressedSize: true,
    rollupOptions: {
      output: {
        // Stable chunk names for SRI hash generation
        entryFileNames: "assets/[name]-[hash].js",
        chunkFileNames: "assets/[name]-[hash].js",
        assetFileNames: "assets/[name]-[hash][extname]"
      }
    }
  },
  server: {
    port: 5173,
    strictPort: true,
    host: "127.0.0.1"
  },
  // No telemetry to Vite / SvelteKit during dev
  clearScreen: false,
  test: {
    include: ["src/**/*.{test,spec}.{js,ts}"],
    // Part 70 closure of REVISIT-LIST G1.E: 97 web unit tests
    // were failing under jsdom because libsodium-wrappers-sumo
    // (and other crypto / Buffer code paths) hits "TypeError:
    // unsupported input type for message" when its global
    // detection picks up jsdom's partial Web Crypto / Buffer
    // shim instead of Node's real one.  Most tests are pure
    // data / crypto / utility — they never touch the DOM.
    // Default to 'node' so those work.  The 8 files that DO
    // need DOM are tagged with `// @vitest-environment jsdom`
    // at the top, per Vitest's per-file override convention.
    environment: "node",
    // cp79-D21: uniform 30s per-test timeout across all
    // workspaces.  apps/web's `src/lib/crypto/crypto.test.ts`
    // runs 52 tests in 5270ms total (~100ms avg), but
    // libsodium-wrappers-sumo + scrypt-style operations have
    // long-tail durations that can spike under battery CPU
    // contention.  Same dynamic-class defense as cp78-D19
    // applied to relay; preemptively closes the gap before
    // the next flake surfaces.
    testTimeout: 3e4
  }
});
export {
  vite_config_default as default
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsidml0ZS5jb25maWcuanMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbImNvbnN0IF9fdml0ZV9pbmplY3RlZF9vcmlnaW5hbF9kaXJuYW1lID0gXCIvaG9tZS9jbGF1ZGUvbW9ycGhpdC9tb3JwaGl0L2FwcHMvd2ViXCI7Y29uc3QgX192aXRlX2luamVjdGVkX29yaWdpbmFsX2ZpbGVuYW1lID0gXCIvaG9tZS9jbGF1ZGUvbW9ycGhpdC9tb3JwaGl0L2FwcHMvd2ViL3ZpdGUuY29uZmlnLmpzXCI7Y29uc3QgX192aXRlX2luamVjdGVkX29yaWdpbmFsX2ltcG9ydF9tZXRhX3VybCA9IFwiZmlsZTovLy9ob21lL2NsYXVkZS9tb3JwaGl0L21vcnBoaXQvYXBwcy93ZWIvdml0ZS5jb25maWcuanNcIjtpbXBvcnQgeyBzdmVsdGVraXQgfSBmcm9tICdAc3ZlbHRlanMva2l0L3ZpdGUnO1xuaW1wb3J0IHsgZGVmaW5lQ29uZmlnIH0gZnJvbSAndml0ZSc7XG5pbXBvcnQgeyByZWFkRmlsZVN5bmMgfSBmcm9tICdub2RlOmZzJztcbmltcG9ydCB7IGZpbGVVUkxUb1BhdGggfSBmcm9tICdub2RlOnVybCc7XG5pbXBvcnQgeyBkaXJuYW1lLCByZXNvbHZlIH0gZnJvbSAnbm9kZTpwYXRoJztcblxuY29uc3QgSEVSRSA9IGRpcm5hbWUoZmlsZVVSTFRvUGF0aChpbXBvcnQubWV0YS51cmwpKTtcbmNvbnN0IHBrZyA9IEpTT04ucGFyc2UocmVhZEZpbGVTeW5jKHJlc29sdmUoSEVSRSwgJ3BhY2thZ2UuanNvbicpLCAndXRmOCcpKTtcblxuZXhwb3J0IGRlZmF1bHQgZGVmaW5lQ29uZmlnKHtcblx0cGx1Z2luczogW3N2ZWx0ZWtpdCgpXSxcblxuXHRkZWZpbmU6IHtcblx0XHQvLyBCYXRjaCBKOiBiYWtlIHRoZSBwYWNrYWdlLmpzb24gdmVyc2lvbiBpbnRvIHRoZSBidW5kbGUgc29cblx0XHQvLyB0aGUgcmVsZWFzZS10cnVzdC1hbmNob3IgbW9kdWxlIGNhbiBjb21wYXJlIHJ1bm5pbmcgdnNcblx0XHQvLyBhbm5vdW5jZWQgdmVyc2lvbi4gIEF2YWlsYWJsZSB0aHJvdWdob3V0IHRoZSBhcHAgYXNcblx0XHQvLyBgX19NT1JQSElUX1ZFUlNJT05fX2AuXG5cdFx0X19NT1JQSElUX1ZFUlNJT05fXzogSlNPTi5zdHJpbmdpZnkocGtnLnZlcnNpb24pXG5cdH0sXG5cblx0YnVpbGQ6IHtcblx0XHR0YXJnZXQ6ICdlczIwMjInLFxuXHRcdG1pbmlmeTogJ2VzYnVpbGQnLFxuXHRcdGNzc01pbmlmeTogJ2xpZ2h0bmluZ2NzcycsXG5cdFx0c291cmNlbWFwOiBmYWxzZSxcblx0XHRyZXBvcnRDb21wcmVzc2VkU2l6ZTogdHJ1ZSxcblx0XHRyb2xsdXBPcHRpb25zOiB7XG5cdFx0XHRvdXRwdXQ6IHtcblx0XHRcdFx0Ly8gU3RhYmxlIGNodW5rIG5hbWVzIGZvciBTUkkgaGFzaCBnZW5lcmF0aW9uXG5cdFx0XHRcdGVudHJ5RmlsZU5hbWVzOiAnYXNzZXRzL1tuYW1lXS1baGFzaF0uanMnLFxuXHRcdFx0XHRjaHVua0ZpbGVOYW1lczogJ2Fzc2V0cy9bbmFtZV0tW2hhc2hdLmpzJyxcblx0XHRcdFx0YXNzZXRGaWxlTmFtZXM6ICdhc3NldHMvW25hbWVdLVtoYXNoXVtleHRuYW1lXSdcblx0XHRcdH1cblx0XHR9XG5cdH0sXG5cblx0c2VydmVyOiB7XG5cdFx0cG9ydDogNTE3Myxcblx0XHRzdHJpY3RQb3J0OiB0cnVlLFxuXHRcdGhvc3Q6ICcxMjcuMC4wLjEnXG5cdH0sXG5cblx0Ly8gTm8gdGVsZW1ldHJ5IHRvIFZpdGUgLyBTdmVsdGVLaXQgZHVyaW5nIGRldlxuXHRjbGVhclNjcmVlbjogZmFsc2UsXG5cblx0dGVzdDoge1xuXHRcdGluY2x1ZGU6IFsnc3JjLyoqLyoue3Rlc3Qsc3BlY30ue2pzLHRzfSddLFxuXHRcdC8vIFBhcnQgNzAgY2xvc3VyZSBvZiBSRVZJU0lULUxJU1QgRzEuRTogOTcgd2ViIHVuaXQgdGVzdHNcblx0XHQvLyB3ZXJlIGZhaWxpbmcgdW5kZXIganNkb20gYmVjYXVzZSBsaWJzb2RpdW0td3JhcHBlcnMtc3Vtb1xuXHRcdC8vIChhbmQgb3RoZXIgY3J5cHRvIC8gQnVmZmVyIGNvZGUgcGF0aHMpIGhpdHMgXCJUeXBlRXJyb3I6XG5cdFx0Ly8gdW5zdXBwb3J0ZWQgaW5wdXQgdHlwZSBmb3IgbWVzc2FnZVwiIHdoZW4gaXRzIGdsb2JhbFxuXHRcdC8vIGRldGVjdGlvbiBwaWNrcyB1cCBqc2RvbSdzIHBhcnRpYWwgV2ViIENyeXB0byAvIEJ1ZmZlclxuXHRcdC8vIHNoaW0gaW5zdGVhZCBvZiBOb2RlJ3MgcmVhbCBvbmUuICBNb3N0IHRlc3RzIGFyZSBwdXJlXG5cdFx0Ly8gZGF0YSAvIGNyeXB0byAvIHV0aWxpdHkgXHUyMDE0IHRoZXkgbmV2ZXIgdG91Y2ggdGhlIERPTS5cblx0XHQvLyBEZWZhdWx0IHRvICdub2RlJyBzbyB0aG9zZSB3b3JrLiAgVGhlIDggZmlsZXMgdGhhdCBET1xuXHRcdC8vIG5lZWQgRE9NIGFyZSB0YWdnZWQgd2l0aCBgLy8gQHZpdGVzdC1lbnZpcm9ubWVudCBqc2RvbWBcblx0XHQvLyBhdCB0aGUgdG9wLCBwZXIgVml0ZXN0J3MgcGVyLWZpbGUgb3ZlcnJpZGUgY29udmVudGlvbi5cblx0XHRlbnZpcm9ubWVudDogJ25vZGUnLFxuXHRcdC8vIGNwNzktRDIxOiB1bmlmb3JtIDMwcyBwZXItdGVzdCB0aW1lb3V0IGFjcm9zcyBhbGxcblx0XHQvLyB3b3Jrc3BhY2VzLiAgYXBwcy93ZWIncyBgc3JjL2xpYi9jcnlwdG8vY3J5cHRvLnRlc3QudHNgXG5cdFx0Ly8gcnVucyA1MiB0ZXN0cyBpbiA1MjcwbXMgdG90YWwgKH4xMDBtcyBhdmcpLCBidXRcblx0XHQvLyBsaWJzb2RpdW0td3JhcHBlcnMtc3VtbyArIHNjcnlwdC1zdHlsZSBvcGVyYXRpb25zIGhhdmVcblx0XHQvLyBsb25nLXRhaWwgZHVyYXRpb25zIHRoYXQgY2FuIHNwaWtlIHVuZGVyIGJhdHRlcnkgQ1BVXG5cdFx0Ly8gY29udGVudGlvbi4gIFNhbWUgZHluYW1pYy1jbGFzcyBkZWZlbnNlIGFzIGNwNzgtRDE5XG5cdFx0Ly8gYXBwbGllZCB0byByZWxheTsgcHJlZW1wdGl2ZWx5IGNsb3NlcyB0aGUgZ2FwIGJlZm9yZVxuXHRcdC8vIHRoZSBuZXh0IGZsYWtlIHN1cmZhY2VzLlxuXHRcdHRlc3RUaW1lb3V0OiAzMF8wMDBcblx0fVxufSk7XG4iXSwKICAibWFwcGluZ3MiOiAiO0FBQWlTLFNBQVMsaUJBQWlCO0FBQzNULFNBQVMsb0JBQW9CO0FBQzdCLFNBQVMsb0JBQW9CO0FBQzdCLFNBQVMscUJBQXFCO0FBQzlCLFNBQVMsU0FBUyxlQUFlO0FBSmlKLElBQU0sMkNBQTJDO0FBTW5PLElBQU0sT0FBTyxRQUFRLGNBQWMsd0NBQWUsQ0FBQztBQUNuRCxJQUFNLE1BQU0sS0FBSyxNQUFNLGFBQWEsUUFBUSxNQUFNLGNBQWMsR0FBRyxNQUFNLENBQUM7QUFFMUUsSUFBTyxzQkFBUSxhQUFhO0FBQUEsRUFDM0IsU0FBUyxDQUFDLFVBQVUsQ0FBQztBQUFBLEVBRXJCLFFBQVE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBLElBS1AscUJBQXFCLEtBQUssVUFBVSxJQUFJLE9BQU87QUFBQSxFQUNoRDtBQUFBLEVBRUEsT0FBTztBQUFBLElBQ04sUUFBUTtBQUFBLElBQ1IsUUFBUTtBQUFBLElBQ1IsV0FBVztBQUFBLElBQ1gsV0FBVztBQUFBLElBQ1gsc0JBQXNCO0FBQUEsSUFDdEIsZUFBZTtBQUFBLE1BQ2QsUUFBUTtBQUFBO0FBQUEsUUFFUCxnQkFBZ0I7QUFBQSxRQUNoQixnQkFBZ0I7QUFBQSxRQUNoQixnQkFBZ0I7QUFBQSxNQUNqQjtBQUFBLElBQ0Q7QUFBQSxFQUNEO0FBQUEsRUFFQSxRQUFRO0FBQUEsSUFDUCxNQUFNO0FBQUEsSUFDTixZQUFZO0FBQUEsSUFDWixNQUFNO0FBQUEsRUFDUDtBQUFBO0FBQUEsRUFHQSxhQUFhO0FBQUEsRUFFYixNQUFNO0FBQUEsSUFDTCxTQUFTLENBQUMsOEJBQThCO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQSxJQVd4QyxhQUFhO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBLElBU2IsYUFBYTtBQUFBLEVBQ2Q7QUFDRCxDQUFDOyIsCiAgIm5hbWVzIjogW10KfQo=
