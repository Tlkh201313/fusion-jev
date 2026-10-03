/** fusion_evidence: retrieve exact receipt bytes or import attributed host research as untrusted evidence. */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { importResearch } from '../research.js';
import type { ToolContext } from './context.js';
import { resultContent } from './render.js';
import { evidenceSchema, type ToolSpecs } from './schemas.js';

const INVALID_EVIDENCE = 'Invalid evidence import or byte range.';

export function registerEvidenceTool(server: McpServer, ctx: ToolContext, specs: ToolSpecs): void {
  const store = ctx.evidence;
  server.registerTool('fusion_evidence', specs.evidence, async (input) => {
    try {
      const parsed = evidenceSchema.parse(input);
      if (parsed.action === 'import') {
        const { action: _action, ...research } = parsed;
        const receipt = importResearch(research, store);
        return resultContent({ receipt, provenance: receipt.source, untrusted: true });
      }
      const { action: _action, format, ...range } = parsed;
      const page = await store.expand(range);
      if (page.status !== 'ok' && page.status !== 'stale') return resultContent(page);
      if (format === 'utf8') {
        try {
          const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
            Buffer.from(page.dataBase64, 'base64'),
          );
          const { dataBase64: _bytes, ...metadata } = page;
          return {
            content: [
              {
                type: 'text' as const,
                text: `evidence=${page.receipt.id} status=${page.status} bytes=${page.startByte}-${page.startByte + Buffer.byteLength(text)} nextByte=${page.nextByte ?? 'none'} truncated=${page.receipt.truncated} redacted=${page.receipt.redacted}\n${text}`,
              },
            ],
            structuredContent: { ...metadata, encoding: 'utf8' },
          };
        } catch {
          return resultContent({
            ...page,
            encoding: 'base64',
            utf8Unavailable:
              'Range contains binary bytes or splits a UTF-8 sequence; use exact base64 or choose a complete text range.',
          });
        }
      }
      let preview: string | undefined;
      try {
        preview = new TextDecoder('utf-8', { fatal: true })
          .decode(Buffer.from(page.dataBase64, 'base64'))
          .slice(0, 200);
      } catch {
        /* A byte range can split a UTF-8 sequence; exact base64 remains available. */
      }
      return resultContent({ ...page, ...(preview === undefined ? {} : { preview }) });
    } catch {
      return {
        isError: true,
        content: [{ type: 'text' as const, text: INVALID_EVIDENCE }],
        structuredContent: { error: { code: 'INVALID_EVIDENCE', message: INVALID_EVIDENCE } },
      };
    }
  });
}
