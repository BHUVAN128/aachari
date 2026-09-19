import type { NextConfig } from "next";
import { config } from "dotenv";

config({ path: new URL("../../.env.local", import.meta.url).pathname });
config({ path: new URL("../../.env", import.meta.url).pathname });

const nextConfig: NextConfig = {
  transpilePackages: ["@upcraft/contracts", "@upcraft/db", "@upcraft/providers", "@upcraft/pipeline", "@upcraft/compositor"],
  serverExternalPackages: ["postgres", "ioredis", "bullmq", "@aws-sdk/client-s3"],
};

export default nextConfig;
