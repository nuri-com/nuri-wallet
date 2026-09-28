import { describe } from "vitest";

type LiveSuiteFactory = () => void | Promise<void>;

export function describeLiveIfEnv(
  name: string,
  requiredEnv: readonly string[],
  factory: LiveSuiteFactory,
): void {
  const missingEnv = requiredEnv.filter((key) => !process.env[key]);

  if (missingEnv.length > 0) {
    console.warn(`[live-test] Skipping ${name}: missing required env ${missingEnv.join(", ")}`);
    describe.skip(name, () => {});
    return;
  }

  describe(name, factory);
}
