import type { NextConfig } from "next";

const panelUrl = (process.env.PANEL_URL ?? "http://127.0.0.1:7465").replace(/\/$/, "");

const nextConfig: NextConfig = {
  reactStrictMode: true,
  async rewrites() {
    return [
      {
        source: "/api/:path*",
        destination: `${panelUrl}/api/:path*`,
      },
    ];
  },
};

export default nextConfig;
