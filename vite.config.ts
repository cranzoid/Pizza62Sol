import vinext from "vinext";
import { defineConfig } from "vite";

// macOS Seatbelt blocks FSEvents, so Codex previews need polling for HMR.
const isCodexSeatbeltSandbox = process.env.CODEX_SANDBOX === "seatbelt";

// Node-native packages are required at runtime instead of bundled. They are
// CommonJS and reach for `__dirname` and dynamic `require`, neither of which
// survives being rolled into an ES module bundle. `@azure/identity` is the
// clearest case: it pulls in `open`, which resolves a helper binary relative to
// `__dirname` and crashes the server on boot.
const serverExternals = [
  "pg",
  "pg-native",
  "@azure/storage-blob",
  "@azure/identity",
];

export default defineConfig({
  server: isCodexSeatbeltSandbox
    ? { watch: { useFsEvents: false, usePolling: true } }
    : undefined,
  plugins: [vinext()],
  ssr: {
    external: serverExternals,
  },
  build: {
    rollupOptions: {
      external: serverExternals,
    },
  },
});
