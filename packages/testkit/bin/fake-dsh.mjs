#!/usr/bin/env node
// Stand-in for `dsh --profile headless --json -` (DeepSeek Harness 0.2.x) used by the
// dsh-bridge contract tests. It speaks the same NDJSON event protocol:
//   session → status(turn_start) → status(step_start) → [thinking] → text → status(step_end, usage)
//   → status(turn_end, reason) → final
// Behaviour is selected with FAKE_DSH_SCENARIO:
//   success | hang | invalid_output | crash | refusal | max_tokens | error_event | over_budget
//   | thinking_secret | no_final | ignore_sigterm | slow | env_keys | missing_credential
import { argv, env, exit, stdin, stdout } from 'node:process';

const args = argv.slice(2);
if (args.includes('--version')) {
  stdout.write(`dsh ${env.FAKE_DSH_VERSION ?? '0.2.0-rc.1'}\n`);
  exit(0);
}

const scenario = env.FAKE_DSH_SCENARIO ?? 'success';
// env_keys: answer with the names of the environment variables the child received.
const answer = scenario === 'env_keys' ? Object.keys(env).sort().join(',') : (env.FAKE_DSH_ANSWER ?? '42');
const emit = (event) => stdout.write(`${JSON.stringify(event)}\n`);

let prompt = '';
stdin.setEncoding('utf8');
stdin.on('data', (chunk) => (prompt += chunk));
stdin.on('end', () => void run());

async function run() {
  if (scenario === 'ignore_sigterm') process.on('SIGTERM', () => {});
  emit({ type: 'session', sessionId: `session-${process.pid}`, cwd: process.cwd() });
  emit({ type: 'status', phase: 'turn_start', turn: 1 });
  emit({ type: 'status', phase: 'step_start', turn: 1, step: 1 });

  if (scenario === 'hang' || scenario === 'ignore_sigterm') {
    setInterval(() => {}, 1000);
    return;
  }
  if (scenario === 'slow') await new Promise((r) => setTimeout(r, Number(env.FAKE_DSH_DELAY_MS ?? 500)));
  if (scenario === 'crash') process.kill(process.pid, 'SIGSEGV');
  if (scenario === 'thinking_secret') emit({ type: 'thinking', text: 'my reasoning mentions sk-THISMUSTNEVERBESTORED1234567890' });

  emit({ type: 'tool_call', callId: 'c1', tool: 'read_file', input: { path: 'README.md' } });
  emit({ type: 'tool_result', callId: 'c1', status: 'completed', result: 'ok' });
  emit({ type: 'text', text: 'working on it' });

  const usage = scenario === 'over_budget' ? { inputTokens: 900000, outputTokens: 900000 } : { inputTokens: 1200, outputTokens: 300 };
  emit({ type: 'status', phase: 'step_end', turn: 1, step: 1, usage });

  if (scenario === 'over_budget') {
    setInterval(() => {}, 1000);
    return;
  }
  if (scenario === 'missing_credential') {
    // Verbatim shape of DSH 0.2.0-rc.1 without DEEPSEEK_API_KEY.
    emit({
      type: 'status',
      phase: 'turn_end',
      turn: 1,
      reason: {
        kind: 'error',
        error: { message: 'llm-deepseek: no API key for provider route "deepseek-official"', code: 'MISSING_CREDENTIAL' },
      },
    });
    emit({ type: 'final', text: '' });
    exit(1);
  }
  if (scenario === 'error_event') {
    emit({ type: 'error', message: 'provider unavailable', code: 'provider_error' });
    exit(1);
  }
  if (scenario === 'no_final') exit(0);

  const reason = scenario === 'refusal' ? 'refusal' : scenario === 'max_tokens' ? 'max-tokens' : 'completed';
  emit({ type: 'status', phase: 'turn_end', turn: 1, reason });
  if (reason !== 'completed') {
    emit({ type: 'final', text: '' });
    exit(1);
  }

  const envelope = {
    schemaVersion: '1.0',
    tier: 1,
    taskScope: 'fake task',
    claims: [
      {
        id: 'answer',
        statement: answer,
        confidence: 0.75,
        assumptions: [`prompt-bytes:${Buffer.byteLength(prompt)}`],
        dependencies: [],
        status: 'verified',
      },
    ],
    evidence: [{ kind: 'tool-result', summary: 'read README.md' }],
  };
  const text =
    scenario === 'invalid_output'
      ? 'I think the answer is 42 but I will not use JSON.'
      : `Here is my answer.\n\n\`\`\`json\n${JSON.stringify(envelope, null, 2)}\n\`\`\`\n`;
  emit({ type: 'final', text });
  exit(0);
}
