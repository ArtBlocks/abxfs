import { createMDX } from "fumadocs-mdx/next";
import { resolve } from "node:path";

const withMDX = createMDX();

/** @type {import('next').NextConfig} */
const config = {
  reactStrictMode: true,
  // The repo root, so Turbopack does not mistake site/ for the workspace root
  // and miss the pnpm-linked dependencies above it.
  turbopack: { root: resolve(import.meta.dirname, "..") },
  async redirects() {
    // The landing page IS the docs overview, so /docs has no page of its own.
    return [
      { source: "/docs", destination: "/", permanent: true },
    ];
  },
};

export default withMDX(config);
