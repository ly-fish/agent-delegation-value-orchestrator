import { fileURLToPath } from 'node:url';

/** Absolute path of the fake `dsh` launcher shipped with the testkit. */
export const FAKE_DSH_PATH = fileURLToPath(new URL('../bin/fake-dsh.mjs', import.meta.url));

/** Launcher argv for a DshRuntimeLock that runs the fake `dsh` with the current Node binary. */
export function fakeDshCommand(): string[] {
  return [process.execPath, FAKE_DSH_PATH];
}
