// Container entry point: `node apps/service/dist/main.js` ≡ `harness serve`.
import { main } from './cli.ts';

main(['serve', ...process.argv.slice(2)]).catch((error: unknown) => {
  process.stderr.write(`fatal: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
