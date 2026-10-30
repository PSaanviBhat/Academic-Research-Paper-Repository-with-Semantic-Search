import path from "node:path";
import { loadEnvConfig } from "@next/env";
import type { NextConfig } from "next";

// The project keeps ONE .env file at the repository root (shared with
// docker-compose and the Python scripts). Load it here so the API routes
// can read DATABASE_URL and SESSION_SECRET. forceReload = true because
// Next.js has already loaded (and cached) the env files of web/ by now.
loadEnvConfig(path.resolve(process.cwd(), ".."), process.env.NODE_ENV !== "production", console, true);

const nextConfig: NextConfig = {
  // pg is a Node-only library; keep it out of the bundler.
  serverExternalPackages: ["pg"],
};

export default nextConfig;
