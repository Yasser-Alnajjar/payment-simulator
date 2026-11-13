import path from "node:path";
import { config } from "dotenv";
import { defineConfig } from "prisma/config";

// Credentials live only in the repo-root .env (gitignored).
config({ path: path.resolve(__dirname, "../../.env"), quiet: true });

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: { path: "prisma/migrations" },
  datasource: {
    // Migrations always use DIRECT_URL (direct connection or session pooler), never the transaction pooler.
    url: process.env.DIRECT_URL ?? "postgresql://placeholder:placeholder@localhost:1/placeholder",
  },
});
