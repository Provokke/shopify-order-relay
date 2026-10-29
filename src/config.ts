export function requireEnv(name: string, env: Record<string, string | undefined> = process.env): string {
  const v = env[name];
  if (!v) throw new Error(`Missing required environment variable ${name}`);
  return v;
}
