import z from "zod";

const EnvSchema = z.object({
  APP_PORT: z.coerce.number().positive().default(3000),
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  APP_STAGE: z.enum(["dev", "prod"]).default("dev"),
  K8_NAMESPACE: z.string().default("default"),
  K8_LABEL: z.string().default("sandbox-runner"),
  LEASE_DURATION_SECONDS: z.coerce.number().positive().default(45),
});

type Env = z.infer<typeof EnvSchema>;
let env: Env;
try {
  env = EnvSchema.parse(process.env);
} catch (error) {
  if (error instanceof z.ZodError) {
    console.error("Invalid environment variables", error);
    console.error(JSON.stringify(z.treeifyError(error), null, 2));

    error.issues.forEach((issue) => {
      const path = issue.path.join(".");
      console.error(`  ${path}: ${issue.message}`);
    });
    process.exit(1);
  }
  throw error;
}

export const isDev = () => env.APP_STAGE === "dev";

export default env;
export { env };
