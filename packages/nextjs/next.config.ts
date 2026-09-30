import type { NextConfig } from "next";
const config: NextConfig = {
  async rewrites() {
    return [
      { source: "/api/:path*", destination: "http://127.0.0.1:3001/:path*" },
      // Local agent runtime for browser setup; it holds the setup and agent keys, never the API.
      { source: "/setup/:path*", destination: "http://127.0.0.1:3002/setup/:path*" },
    ];
  },
};
export default config;
