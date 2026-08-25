import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Vinext traces the packages the production server actually imports and
  // emits them with a small self-hosting server in dist/standalone. Deploying
  // that tree avoids shipping the complete build-time node_modules directory.
  output: "standalone",
  experimental: {
    serverActions: {
      // Nothing to do with server actions — this app has none. The framework
      // applies this limit to *any* POST carrying a multipart body, before the
      // router matches a route, so the 1 MB default was quietly capping menu and
      // branding photo uploads: anything larger was refused with a plain-text
      // 413 that `/api/uploads` never saw, and that the editor — which expects
      // this endpoint to answer in JSON — reported as "Unexpected end of JSON
      // input" to whoever was trying to add a picture.
      //
      // It has to stay above `MAX_UPLOAD_BYTES` in `lib/image-validation.ts`, so
      // that an oversized file is rejected by the route, which can say what the
      // limit is, rather than by the gate in front of it, which cannot.
      bodySizeLimit: "6mb",
    },
  },
};

export default nextConfig;
