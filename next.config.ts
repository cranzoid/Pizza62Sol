import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Vinext traces the packages the production server actually imports and
  // emits them with a small self-hosting server in dist/standalone. Deploying
  // that tree avoids shipping the complete build-time node_modules directory.
  output: "standalone",
};

export default nextConfig;
