/**
 * Metric catalog (design §11.2). Declared once here so every emitter uses the same
 * names and label sets, and the exposition layer can register them up front.
 */
export type MetricType = 'counter' | 'gauge' | 'histogram';

export interface MetricDefinition {
  type: MetricType;
  help: string;
  labels: readonly string[];
  buckets?: readonly number[];
}

const SECONDS = [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 120, 300];
const USD = [0.0001, 0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1, 5];
const BYTES = [256, 1024, 4096, 16_384, 65_536, 262_144, 1_048_576];

export const METRICS = {
  dvo_tasks_total: { type: 'counter', help: 'Finalised tasks by outcome and verification status.', labels: ['outcome', 'verification'] },
  dvo_task_cost_usd: { type: 'histogram', help: 'Committed cost per finalised task.', labels: [], buckets: USD },
  dvo_task_tokens_total: { type: 'counter', help: 'Tokens consumed by finalised tasks.', labels: ['direction'] },
  dvo_task_duration_seconds: { type: 'histogram', help: 'Wall-clock task latency.', labels: ['outcome'], buckets: SECONDS },
  dvo_decisions_total: { type: 'counter', help: 'Policy decisions by selected action.', labels: ['action', 'explored', 'policy'] },
  dvo_decision_blocked_total: { type: 'counter', help: 'Candidate actions blocked, by reason.', labels: ['action', 'reason'] },
  dvo_attempts_total: {
    type: 'counter',
    help: 'Settled attempts by executor and terminal status.',
    labels: ['executor', 'kind', 'terminal'],
  },
  dvo_attempt_duration_seconds: { type: 'histogram', help: 'Attempt latency by executor.', labels: ['executor'], buckets: SECONDS },
  dvo_attempts_active: { type: 'gauge', help: 'Attempts currently in flight.', labels: [] },
  dvo_late_results_total: { type: 'counter', help: 'Results that arrived after a cancel request.', labels: ['executor', 'accepted'] },
  dvo_transitions_rejected_total: {
    type: 'counter',
    help: 'Out-of-order or duplicate inputs refused by the state machine.',
    labels: ['entity'],
  },
  dvo_peer_requests_total: { type: 'counter', help: 'A2A requests by peer, method and outcome.', labels: ['peer', 'method', 'outcome'] },
  dvo_peer_submission_unknown_total: { type: 'counter', help: 'Submissions whose delivery could not be determined.', labels: ['peer'] },
  dvo_artifact_rejections_total: { type: 'counter', help: 'Artifacts refused at the boundary, by reason.', labels: ['source', 'reason'] },
  dvo_evidence_envelopes_total: {
    type: 'counter',
    help: 'Evidence envelopes exchanged, by direction and tier.',
    labels: ['direction', 'tier'],
  },
  dvo_evidence_bytes: { type: 'histogram', help: 'Serialised envelope size.', labels: ['direction'], buckets: BYTES },
  dvo_evidence_outcome_total: {
    type: 'counter',
    help: 'What each received envelope contributed to (final/verified/refuted/unused).',
    labels: ['outcome'],
  },
  dvo_injection_flags_total: { type: 'counter', help: 'Inbound content flagged for prompt-injection risk.', labels: ['level'] },
  dvo_redactions_total: { type: 'counter', help: 'Redactions applied, by location.', labels: ['where'] },
  dvo_scheduler_queue_length: { type: 'gauge', help: 'Attempts waiting for a concurrency slot.', labels: ['pool'] },
  dvo_retries_total: { type: 'counter', help: 'Retries performed, by operation.', labels: ['operation'] },
  dvo_circuit_state: { type: 'gauge', help: 'Circuit state per peer (0 closed, 1 half-open, 2 open).', labels: ['peer'] },
  dvo_recovery_duration_seconds: {
    type: 'histogram',
    help: 'Time to recover non-terminal work after start-up.',
    labels: [],
    buckets: SECONDS,
  },
  dvo_recovered_attempts_total: { type: 'counter', help: 'Attempts recovered after restart, by action taken.', labels: ['action'] },
  dvo_budget_violations_total: { type: 'counter', help: 'Committed spend exceeding a hard budget (must stay 0).', labels: ['dimension'] },
} as const satisfies Record<string, MetricDefinition>;

export type MetricName = keyof typeof METRICS;
export type Labels = Record<string, string>;

export interface MetricsSink {
  inc(name: MetricName, labels?: Labels, value?: number): void;
  set(name: MetricName, value: number, labels?: Labels): void;
  observe(name: MetricName, value: number, labels?: Labels): void;
}

export const noopMetrics: MetricsSink = { inc: () => undefined, set: () => undefined, observe: () => undefined };
