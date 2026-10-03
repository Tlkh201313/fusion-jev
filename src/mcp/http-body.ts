/** HTTP request parsing for the MCP endpoint: strict JSON (no duplicate keys, bounded depth) and bounded bodies. */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { researchImportSchema } from '../research.js';

export function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  response.end(JSON.stringify(body));
}

function parseUniqueJson(bytes: Buffer): unknown {
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { throw new SyntaxError('Invalid JSON encoding'); }
  let index = 0;
  const whitespace = () => { while (/[\t\n\r ]/u.test(text[index] ?? '')) index++; };
  const string = (): string => {
    const start = index++;
    let escaped = false;
    while (index < text.length) {
      const char = text[index++]!;
      if (escaped) { escaped = false; continue; }
      if (char === '\\') { escaped = true; continue; }
      if (char === '"') return JSON.parse(text.slice(start, index));
    }
    throw new SyntaxError('Unterminated JSON string');
  };
  const value = (depth: number): unknown => {
    if (depth > 64) throw new SyntaxError('JSON nesting limit exceeded');
    whitespace();
    const char = text[index];
    if (char === '"') return string();
    if (char === '{') {
      index++; whitespace();
      const object: Record<string, unknown> = {};
      const keys = new Set<string>();
      if (text[index] === '}') { index++; return object; }
      while (true) {
        if (text[index] !== '"') throw new SyntaxError('Expected JSON object key');
        const key = string();
        if (keys.has(key)) throw new SyntaxError('Duplicate JSON key');
        keys.add(key);
        whitespace(); if (text[index++] !== ':') throw new SyntaxError('Expected JSON colon');
        const member = value(depth + 1);
        Object.defineProperty(object, key, { value: member, enumerable: true, configurable: true, writable: true });
        whitespace();
        const separator = text[index++];
        if (separator === '}') return object;
        if (separator !== ',') throw new SyntaxError('Expected JSON object separator');
        whitespace();
      }
    }
    if (char === '[') {
      index++; whitespace();
      const array: unknown[] = [];
      if (text[index] === ']') { index++; return array; }
      while (true) {
        array.push(value(depth + 1));
        whitespace();
        const separator = text[index++];
        if (separator === ']') return array;
        if (separator !== ',') throw new SyntaxError('Expected JSON array separator');
      }
    }
    for (const [literal, parsed] of [['true', true], ['false', false], ['null', null]] as const) {
      if (text.startsWith(literal, index)) { index += literal.length; return parsed; }
    }
    const number = /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/y;
    number.lastIndex = index;
    const matched = number.exec(text);
    if (matched) { index = number.lastIndex; return JSON.parse(matched[0]); }
    throw new SyntaxError('Invalid JSON value');
  };
  const parsed = value(0);
  whitespace();
  if (index !== text.length) throw new SyntaxError('Unexpected JSON suffix');
  return parsed;
}

function isResearchImportEnvelope(body: unknown): boolean {
  if (!body || typeof body !== 'object') return false;
  const request = body as Record<string, unknown>;
  if (request.method !== 'tools/call' || !request.params || typeof request.params !== 'object') return false;
  const params = request.params as Record<string, unknown>;
  if (params.name !== 'fusion_evidence' || !params.arguments || typeof params.arguments !== 'object') return false;
  const args = params.arguments as Record<string, unknown>;
  if (args.action !== 'import') return false;
  const { action: _action, ...research } = args;
  return researchImportSchema.safeParse(research).success;
}

export function readBody(request: IncomingMessage, maxBytes: number, researchMaxBytes: number, signal: AbortSignal): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks: Buffer[] = [];
    const cleanup = () => { request.off('data', data); request.off('end', end); request.off('error', error); signal.removeEventListener('abort', abort); };
    const error = (cause: Error) => { cleanup(); reject(cause); };
    const abort = () => error(new Error('Request timed out'));
    const data = (chunk: Buffer) => {
      size += chunk.length;
      if (size > researchMaxBytes) { cleanup(); request.resume(); reject(new RangeError('Request exceeds body limit')); return; }
      chunks.push(chunk);
    };
    const end = () => {
      cleanup();
      let body: unknown;
      try { body = parseUniqueJson(Buffer.concat(chunks)); }
      catch { reject(new SyntaxError('Invalid JSON')); return; }
      if (size > maxBytes && !isResearchImportEnvelope(body)) reject(new RangeError('Request exceeds body limit'));
      else resolve(body);
    };
    request.on('data', data); request.once('end', end); request.once('error', error); signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
}
