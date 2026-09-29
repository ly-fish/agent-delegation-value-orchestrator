import { mulberry32 } from '@dvo/core';

/**
 * Controlled DAG task family (design §14 M4): arithmetic dependency graphs whose answer is
 * computed exactly, so every outcome is scored by a deterministic verifier, never a judge.
 * Depth (critical-path length) is the controlled hardness knob; `independent` marks tasks
 * whose sub-computations could be solved separately (low dependency coupling).
 */
export interface DagTask {
  tag: string;
  goal: string;
  answer: number;
  depth: number;
  independent: boolean;
}

const OPS = ['+', '-', '*'] as const;

export function generateTasks(count: number, seed: number, maxDepth = 6): DagTask[] {
  const random = mulberry32(seed);
  const int = (lo: number, hi: number) => lo + Math.floor(random() * (hi - lo + 1));
  return Array.from({ length: count }, (_, i) => {
    const depth = int(1, maxDepth);
    const names: string[] = [];
    const values: number[] = [];
    const lines: string[] = [];
    const leaves = int(2, 3);
    for (let l = 0; l < leaves; l++) {
      const name = `x${l}`;
      const value = int(1, 9);
      names.push(name);
      values.push(value);
      lines.push(`${name} = ${value}`);
    }
    for (let d = 0; d < depth; d++) {
      const a = int(0, names.length - 1);
      const b = int(0, names.length - 1);
      const op = OPS[int(0, OPS.length - 1)]!;
      const value = op === '+' ? values[a]! + values[b]! : op === '-' ? values[a]! - values[b]! : values[a]! * values[b]!;
      const name = `n${d}`;
      lines.push(`${name} = ${names[a]} ${op} ${names[b]}`);
      names.push(name);
      values.push(Math.max(-1e6, Math.min(1e6, value)));
    }
    const tag = `dag-${seed}-${i}`;
    return {
      tag,
      goal: `[${tag}] Given ${lines.join('; ')}. What is ${names.at(-1)}?`,
      answer: values.at(-1)!,
      depth,
      independent: random() < 0.4,
    };
  });
}
