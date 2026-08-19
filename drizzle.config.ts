import type { Config } from "drizzle-kit";

export default {
  out: "./drizzle",
  schema: "./db/schema.ts",
  dialect: "postgresql",
} satisfies Config;
