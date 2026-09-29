// Regenerates schemas/*.json from the zod sources (npm run schemas).
import { writeFileSync } from 'node:fs';
import { envelopeJsonSchema } from '@dvo/evidence';

const schema = {
  $id: 'urn:research:dvo:evidence-envelope:v1',
  title: 'DVO EvidenceEnvelope (wire form, v1.x)',
  ...envelopeJsonSchema(),
};
writeFileSync(new URL('../schemas/evidence-envelope.v1.json', import.meta.url), `${JSON.stringify(schema, null, 2)}\n`);
console.log('wrote schemas/evidence-envelope.v1.json');
