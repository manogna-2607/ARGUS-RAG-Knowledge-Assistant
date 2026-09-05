import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Keep pdf-parse and its optional native canvas dependency available to the
  // Node runtime rather than rewriting their worker path into a server chunk.
  serverExternalPackages: ["pdf-parse", "@napi-rs/canvas"],

  // ARGUS is an App Router application rooted at /. Preserve compatibility for
  // legacy bookmarks without creating a separate index.html page or route.
  async redirects() {
    return [
      {
        source: "/index.html",
        destination: "/",
        permanent: false,
      },
    ];
  },
};

export default nextConfig;
