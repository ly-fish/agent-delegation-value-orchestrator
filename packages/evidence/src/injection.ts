import type { EvidenceEnvelope, InjectionRisk } from '@dvo/core';

interface Signal {
  id: string;
  weight: number;
  pattern: RegExp;
}

/**
 * Heuristic prompt-injection markers (design §6.3.5). A screen, not a classifier: it only
 * decides whether inbound text may be quoted into a model prompt or must stay quarantined
 * for isolated verifiers. False positives cost a little utility; false negatives are
 * contained by never letting peer text carry authority (it is always framed as data).
 */
const SIGNALS: readonly Signal[] = [
  {
    id: 'override_instructions',
    weight: 3,
    pattern:
      /\b(ignore|disregard|forget|override|bypass)\b[^.\n]{0,40}\b(previous|prior|above|earlier|all|any|system|developer)\b[^.\n]{0,24}\b(instructions?|prompts?|rules?|messages?|guidelines?)\b/i,
  },
  { id: 'role_hijack', weight: 2, pattern: /\b(you are now|act as (?:a|an|the)|pretend to be|new instructions?:|from now on,? you)\b/i },
  {
    id: 'system_prompt_reference',
    weight: 2,
    pattern: /\b(system prompt|developer message|hidden instructions?)\b|<\|?(?:system|im_start|im_end)\|?>|\[\/?INST\]/i,
  },
  {
    id: 'tool_invocation',
    weight: 2,
    pattern:
      /\b(run|execute|call|invoke)\b[^.\n]{0,30}\b(command|shell|terminal|tool|function|script)\b|\brm\s+-rf\b|\b(?:curl|wget)\s+[^|\n]*\|\s*(?:sh|bash|zsh)\b/i,
  },
  {
    id: 'credential_solicitation',
    weight: 3,
    pattern:
      /\b(send|reveal|print|share|include|output|leak|post)\b[^.\n]{0,40}\b(api[ -]?keys?|passwords?|tokens?|secrets?|credentials?|env(?:ironment)? var(?:iable)?s?)\b/i,
  },
  { id: 'exfiltration_link', weight: 3, pattern: /!\[[^\]]*\]\(\s*https?:\/\/[^)\s]*[?&][^)\s]*=/i },
  { id: 'invisible_characters', weight: 2, pattern: /[\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF]/ },
  { id: 'encoded_payload', weight: 1, pattern: /[A-Za-z0-9+/]{240,}={0,2}/ },
  { id: 'active_markup', weight: 2, pattern: /<\s*(script|iframe|object|embed|form)\b/i },
];

export interface InjectionAssessment {
  level: InjectionRisk;
  score: number;
  signals: string[];
}

export const INJECTION_THRESHOLDS = { medium: 2, high: 4 } as const;

export function assessInjection(texts: Iterable<string>): InjectionAssessment {
  const found = new Set<string>();
  for (const text of texts) {
    for (const signal of SIGNALS) if (!found.has(signal.id) && signal.pattern.test(text)) found.add(signal.id);
  }
  const score = SIGNALS.filter((s) => found.has(s.id)).reduce((sum, s) => sum + s.weight, 0);
  const level: InjectionRisk = score >= INJECTION_THRESHOLDS.high ? 'high' : score >= INJECTION_THRESHOLDS.medium ? 'medium' : 'low';
  return { level, score, signals: [...found].sort() };
}

/** Every free-text field of an envelope, for screening. */
export function envelopeTexts(envelope: EvidenceEnvelope): string[] {
  const texts = [envelope.taskScope];
  if (envelope.requestedNextAction !== undefined) texts.push(envelope.requestedNextAction);
  for (const claim of envelope.claims) texts.push(claim.statement, ...claim.assumptions, ...claim.dependencies);
  for (const item of envelope.evidence) {
    texts.push(item.summary);
    if (item.verifierHint !== undefined) texts.push(item.verifierHint);
    if (item.uri !== undefined) texts.push(item.uri);
  }
  return texts;
}
