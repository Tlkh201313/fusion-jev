import { z } from 'zod';
import type { EvidenceReceipt, EvidenceStore } from './evidence.js';

const MAX_PASSAGE_BYTES = 256 * 1024;
function wellFormedUtf16(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(++index);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) return false;
  }
  return true;
}
function canonicalRetrievalTime(value: string): string {
  const parts = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:\d{2})$/u.exec(value);
  if (!parts) throw new Error('Invalid retrieval timestamp');
  const second = new Date(`${parts[1]}${parts[3]}`).toISOString().slice(0, 19);
  const significantFraction = (parts[2] ?? '').replace(/0+$/u, '');
  return `${second}.${significantFraction ? significantFraction.padEnd(3, '0') : '000'}Z`;
}
const urlSchema = z.url().refine((value) => {
  try {
    const url = new URL(value);
    return (
      (url.protocol === 'http:' || url.protocol === 'https:') &&
      Boolean(url.hostname) &&
      !url.username &&
      !url.password &&
      !/[\u0000-\u001f\u007f]/u.test(value) &&
      wellFormedUtf16(value)
    );
  } catch {
    return false;
  }
}, 'Expected an HTTP(S) URL without credentials');

export const researchImportSchema = z.strictObject({
  url: urlSchema,
  title: z.string().trim().min(1).max(1000).refine(wellFormedUtf16, 'Malformed Unicode').optional(),
  retrievedAt: z.iso.datetime({ offset: true }),
  passageId: z.string().trim().min(1).max(512).refine(wellFormedUtf16, 'Malformed Unicode'),
  passage: z
    .string()
    .refine((value) => value.trim().length > 0, 'Passage must be nonempty')
    .refine(wellFormedUtf16, 'Malformed Unicode')
    .refine((value) => Buffer.byteLength(value, 'utf8') <= MAX_PASSAGE_BYTES, 'Passage exceeds 256 KiB'),
  sourceTool: z.enum(['host_search', 'host_browser', 'host_docs']),
});

export type ResearchInput = z.input<typeof researchImportSchema>;

export function importResearch(input: ResearchInput, evidence: EvidenceStore): EvidenceReceipt {
  const research = researchImportSchema.parse(input);
  return evidence.capture({
    source: {
      kind: 'research',
      url: new URL(research.url).href,
      title: research.title,
      retrievedAt: canonicalRetrievalTime(research.retrievedAt),
      passageId: research.passageId,
      sourceTool: research.sourceTool,
      untrusted: true,
    },
    bytes: Buffer.from(research.passage, 'utf8'),
  });
}
