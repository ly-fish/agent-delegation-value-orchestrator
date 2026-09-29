#!/usr/bin/env node
import { createWriteStream } from 'node:fs';
import { parseArgs } from 'node:util';
import { isHarnessError, TaskId, type TaskSpec, ValidationError } from '@dvo/core';
import { envelopeJsonSchema } from '@dvo/evidence';
import { DvoRulePolicy } from '@dvo/policy';
import { exportJsonl, replayTask } from '@dvo/trace';
import { buildApp } from './compose.ts';
import { defaultConfigDir, loadConfig } from './config/load.ts';
import { createServer } from './http/server.ts';
import { createPino, toCoreLogger } from './logging.ts';

const USAGE = `harness — Delegation Value Orchestrator (DeepSeek Harness + A2A)

Usage:
  harness serve                          start the HTTP service
  harness run --goal <text> [options]    run one task and print its outcome
  harness replay <taskId>                rebuild a task and re-run its decisions
  harness export [--kind events|decisions] [--out file.jsonl]
  harness peers check                    fetch and validate every allowlisted Agent Card
  harness config check                   validate configuration (no secrets printed)
  harness schemas                        print the EvidenceEnvelope JSON Schema

Options:
  --config-dir <dir>     configuration directory (default: $HARNESS_CONFIG_DIR or ./configs)
  --classification <c>   public | internal | restricted | secret      (run)
  --expected <value>     verify the answer with the exact-answer verifier   (run)
  --deadline-ms <n>      task deadline                                      (run)
  --local-only           never delegate                                     (run)
  --json                 machine-readable output
`;

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      'config-dir': { type: 'string' },
      goal: { type: 'string' },
      classification: { type: 'string' },
      expected: { type: 'string' },
      'deadline-ms': { type: 'string' },
      'local-only': { type: 'boolean' },
      kind: { type: 'string' },
      out: { type: 'string' },
      json: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  const [command, sub] = positionals;
  if (values.help === true || command === undefined) {
    process.stdout.write(USAGE);
    return command === undefined && values.help !== true ? 1 : 0;
  }
  if (command === 'schemas') {
    process.stdout.write(`${JSON.stringify(envelopeJsonSchema(), null, 2)}\n`);
    return 0;
  }

  const config = loadConfig(values['config-dir'] ?? defaultConfigDir());
  const pino = createPino(command === 'serve' ? config.service.logging.level : 'warn', command === 'serve' ? undefined : process.stderr);
  const logger = toCoreLogger(pino);

  switch (command) {
    case 'config': {
      if (sub !== 'check') break;
      const summary = {
        dir: config.dir,
        peers: config.peers.map((p) => ({
          id: p.id,
          endpoint: p.endpoint,
          allowed: p.allowed,
          trustTier: p.trustTier,
          credentials: p.credentialsRef === undefined ? 'none' : 'secret-ref',
        })),
        dsh: {
          version: config.lock.dsh.expectedVersion,
          commit: config.lock.dsh.commit,
          profile: config.lock.dsh.profile,
          enabled: config.service.local.enabled,
        },
        a2a: config.lock.a2a,
        verifiers: config.service.verifiers.map((v) => `${v.id} (${v.type})`),
        storage: config.service.storage,
      };
      process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
      return 0;
    }
    case 'serve': {
      const app = await buildApp(config, logger);
      const report = await app.engine.recover();
      const http = await createServer(app, pino);
      await http.listen({ host: config.service.http.host, port: config.service.http.port });
      logger.info({ recovered: report }, 'harness service listening');
      let stopping = false;
      const stop = async (signal: string): Promise<void> => {
        if (stopping) return;
        stopping = true;
        logger.info({ signal }, 'shutting down');
        await http.close();
        // Remote attempts stay submitted and are resumed on the next start; local ones are recovered as orphans.
        await app.close({ cancelActive: false });
        process.exit(0);
      };
      process.on('SIGTERM', () => void stop('SIGTERM'));
      process.on('SIGINT', () => void stop('SIGINT'));
      return await new Promise<number>(() => undefined);
    }
    case 'run': {
      if (values.goal === undefined) throw new ValidationError('--goal is required');
      const app = await buildApp(config, logger);
      await app.engine.recover();
      const spec: TaskSpec = {
        goal: values.goal,
        ...(values.classification === undefined ? {} : { classification: values.classification as TaskSpec['classification'] & string }),
        ...(values.expected === undefined ? {} : { verification: { verifierId: 'exact-answer', params: { expected: values.expected } } }),
        ...(values['deadline-ms'] === undefined ? {} : { budget: { deadlineMs: Number(values['deadline-ms']) } }),
        ...(values['local-only'] === true ? { allowRemote: false } : {}),
      };
      const { taskId } = await app.engine.submit(spec);
      const state = await app.engine.waitForTerminal(taskId);
      await app.close();
      if (values.json === true)
        process.stdout.write(`${JSON.stringify({ taskId, outcome: state.outcome, spent: state.spent }, null, 2)}\n`);
      else {
        const o = state.outcome!;
        process.stdout.write(
          `${o.status} (${o.verificationStatus})${o.answer === undefined ? '' : `: ${o.answer.statement}`}\n  task ${taskId} · $${state.spent.costUsd.toFixed(4)} · ${state.spent.remoteCalls} remote call(s) · ${o.reason}\n`,
        );
      }
      return state.outcome?.status === 'succeeded' ? 0 : 2;
    }
    case 'replay': {
      if (sub === undefined) throw new ValidationError('replay needs a task id');
      const app = await buildApp(config, logger);
      const report = await replayTask(app.store, TaskId(sub), new DvoRulePolicy());
      await app.close();
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      return report.projectionMatches && report.deterministic ? 0 : 3;
    }
    case 'export': {
      const app = await buildApp(config, logger);
      const out = values.out === undefined ? process.stdout : createWriteStream(values.out, { mode: 0o600 });
      for await (const line of exportJsonl(app.store, { kind: values.kind === 'decisions' ? 'decisions' : 'events' })) out.write(line);
      if (out !== process.stdout) await new Promise<void>((resolve) => (out as NodeJS.WritableStream).end(resolve));
      await app.close();
      return 0;
    }
    case 'peers': {
      if (sub !== 'check') break;
      const app = await buildApp(config, logger);
      const rows = await Promise.all(app.catalog.peers.map(async (p) => ({ peerId: p.peerId, ...(await p.executor.capabilities()) })));
      await app.close();
      process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
      return rows.every((r) => r.available) ? 0 : 4;
    }
    default:
      break;
  }
  process.stderr.write(USAGE);
  return 1;
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url.endsWith(process.argv[1].split('/').pop() ?? '');
if (invokedDirectly) {
  main().then(
    (code) => process.exit(code),
    (error: unknown) => {
      if (error instanceof ValidationError)
        process.stderr.write(`error: ${error.safeMessage}\n${error.issues.map((i) => `  - ${i}`).join('\n')}\n`);
      else process.stderr.write(`error: ${isHarnessError(error) ? error.safeMessage : String(error)}\n`);
      process.exit(1);
    },
  );
}
