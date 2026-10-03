/** Streamable-HTTP MCP endpoint: host/origin checks, bearer or OAuth auth, bounded bodies and idle-expiring sessions. */
import { createServer, type Server as HttpServer } from 'node:http';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { EvidenceStore } from '../evidence.js';
import { createTokenVerifier } from '../oauth.js';
import type { FusionConfig } from '../types.js';
import type { McpOptions } from './context.js';
import { readBody, sendJson } from './http-body.js';
import { createFusionMcpServer } from './server.js';

function loopback(host: string): boolean {
  return ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(host);
}

export function validateHttpConfig(config: FusionConfig): void {
  const { http } = config;
  const remote = !loopback(http.host) || Boolean(http.publicUrl);
  if (remote && (!http.oauth || !http.publicUrl)) throw new Error('Remote HTTP requires OAuth and FUSION_PUBLIC_URL');
  if (
    http.publicUrl &&
    (new URL(http.publicUrl).pathname !== '/mcp' || new URL(http.publicUrl).search || new URL(http.publicUrl).hash)
  )
    throw new Error('FUSION_PUBLIC_URL must point to /mcp without query or fragment');
  if (!http.oauth && !http.bearerToken && !http.allowUnauthenticated)
    throw new Error('HTTP requires authentication; local development may explicitly enable unauthenticated access');
  if (http.oauth) {
    for (const url of [http.publicUrl, http.oauth.issuer, http.oauth.jwksUrl, http.oauth.audience]) {
      if (!url || new URL(url).protocol !== 'https:' || new URL(url).username || new URL(url).password)
        throw new Error('OAuth deployment URLs must be HTTPS URLs without credentials');
    }
    if (!http.oauth.ownerSubject || !http.oauth.scopes.length)
      throw new Error('OAuth requires an owner subject and at least one scope');
  }
}

export async function startHttpServer(options: McpOptions): Promise<HttpServer> {
  const { config } = options;
  validateHttpConfig(config);
  const sharedOptions = { ...options, evidence: options.evidence ?? new EvidenceStore() };
  const { http } = config;
  const ordinaryBodyLimit = Math.min(http.maxBodyBytes, 128 * 1024);
  const researchBodyLimit = Math.min(
    2 * 1024 * 1024,
    http.maxBodyBytes < 128 * 1024 ? http.maxBodyBytes : (http.maxResearchBodyBytes ?? http.maxBodyBytes),
  );
  const verifyToken = http.oauth ? createTokenVerifier(http.oauth) : undefined;
  const publicUrl = http.publicUrl ? new URL(http.publicUrl) : undefined;
  const metadataPath = `/.well-known/oauth-protected-resource${publicUrl?.pathname === '/' ? '' : (publicUrl?.pathname ?? '')}`;
  const allowedHosts = new Set(
    http.allowedHosts.length
      ? http.allowedHosts
      : ['127.0.0.1', 'localhost', '::1', publicUrl?.hostname].filter((v): v is string => Boolean(v)),
  );
  const requestSignals = new AsyncLocalStorage<AbortSignal>();
  type HttpSession = {
    id?: string;
    mcp: McpServer;
    transport: WebStandardStreamableHTTPServerTransport;
    inFlight: number;
    idleTimer?: NodeJS.Timeout;
    closed: boolean;
    terminating: boolean;
  };
  const sessions = new Map<string, HttpSession>();
  const maxSessions = Math.min(128, Math.max(16, config.routing.maxConcurrency * 4));
  const sessionIdleMs = 30 * 60 * 1000;
  let pendingSessions = 0;
  const closeSession = async (session: HttpSession) => {
    if (session.closed) return;
    session.closed = true;
    if (session.id && sessions.get(session.id) === session) sessions.delete(session.id);
    if (session.idleTimer) clearTimeout(session.idleTimer);
    await session.mcp.close();
  };
  const armSessionIdle = (session: HttpSession) => {
    if (session.idleTimer) clearTimeout(session.idleTimer);
    session.idleTimer = setTimeout(() => {
      void closeSession(session).catch(() => {});
    }, sessionIdleMs);
    session.idleTimer.unref();
  };
  let active = 0;
  let activeDeletes = 0;
  const server = createServer(async (request, response) => {
    const controller = new AbortController();
    const timeout = setTimeout(() => {
      controller.abort();
      if (!response.headersSent) sendJson(response, 408, { error: 'Request deadline exceeded' });
      else response.destroy();
    }, config.routing.totalTimeoutMs);
    timeout.unref();
    response.once('close', () => {
      clearTimeout(timeout);
      controller.abort();
    });
    const origin = request.headers.origin;
    let host: string;
    try {
      host = new URL(`http://${request.headers.host ?? ''}`).hostname.replace(/^\[|\]$/g, '');
    } catch {
      sendJson(response, 403, { error: 'Invalid host' });
      return;
    }
    if (!allowedHosts.has(host) && !allowedHosts.has(request.headers.host ?? '')) {
      sendJson(response, 403, { error: 'Host not allowed' });
      return;
    }
    if (origin && !http.allowedOrigins.includes(origin)) {
      sendJson(response, 403, { error: 'Origin not allowed' });
      return;
    }
    if (origin) {
      response.setHeader('Access-Control-Allow-Origin', origin);
      response.setHeader('Vary', 'Origin');
    }
    const path = request.url?.split('?')[0];
    if (request.method === 'GET' && path === '/healthz') {
      sendJson(response, 200, { status: 'ok' });
      return;
    }
    if (
      request.method === 'GET' &&
      http.oauth &&
      (path === metadataPath || path === '/.well-known/oauth-protected-resource')
    ) {
      sendJson(response, 200, {
        resource: http.oauth.audience,
        authorization_servers: [http.oauth.issuer],
        scopes_supported: http.oauth.scopes,
        bearer_methods_supported: ['header'],
      });
      return;
    }
    if (path !== '/mcp') {
      sendJson(response, 404, { error: 'Not found' });
      return;
    }
    if (request.method === 'OPTIONS') {
      response.writeHead(204, {
        'Access-Control-Allow-Methods': 'POST, GET, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Authorization, Content-Type, MCP-Protocol-Version, MCP-Session-Id',
        'Access-Control-Expose-Headers': 'WWW-Authenticate, MCP-Session-Id',
      });
      response.end();
      return;
    }
    const deleteMethod = request.method === 'DELETE';
    const ordinaryCapacity = config.routing.maxConcurrency * 4;
    if (deleteMethod ? active >= ordinaryCapacity + 4 || activeDeletes >= 4 : active >= ordinaryCapacity) {
      response.setHeader('Retry-After', '1');
      sendJson(response, 503, { error: 'Server busy' });
      return;
    }
    active++;
    if (deleteMethod) activeDeletes++;
    let session: HttpSession | undefined;
    let creatingSession = false;
    let initializedSession = false;
    let deletingSession = false;
    try {
      const token = /^Bearer ([^\s]+)$/i.exec(request.headers.authorization ?? '')?.[1];
      try {
        if (verifyToken) {
          if (!token) throw new Error('Missing token');
          await verifyToken(token);
        } else if (http.bearerToken) {
          const actual = Buffer.from(token ?? '');
          const expected = Buffer.from(http.bearerToken);
          if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new Error('Invalid token');
        }
      } catch {
        if (controller.signal.aborted || response.writableEnded) return;
        response.setHeader(
          'WWW-Authenticate',
          publicUrl
            ? `Bearer resource_metadata="${publicUrl.origin}${metadataPath}", scope="${http.oauth!.scopes.join(' ')}"`
            : 'Bearer',
        );
        sendJson(response, 401, { error: 'Authentication required' });
        return;
      }
      if (controller.signal.aborted || response.writableEnded) return;
      if (request.method !== 'POST' && request.method !== 'DELETE') {
        response.setHeader('Allow', 'POST, DELETE');
        sendJson(response, 405, { error: 'MCP accepts POST and DELETE only' });
        return;
      }
      const isDelete = deleteMethod;
      let body: unknown;
      if (!isDelete) {
        if (!request.headers['content-type']?.toLowerCase().startsWith('application/json')) {
          sendJson(response, 415, { error: 'Expected application/json' });
          return;
        }
        if (Number(request.headers['content-length'] ?? 0) > researchBodyLimit) {
          sendJson(response, 413, { error: 'Request exceeds body limit' });
          return;
        }
        body = await readBody(request, ordinaryBodyLimit, researchBodyLimit, controller.signal);
      }
      if (controller.signal.aborted || response.writableEnded) return;
      const sessionHeader = request.headers['mcp-session-id'];
      const sessionId = Array.isArray(sessionHeader) ? undefined : sessionHeader;
      if (isDelete && sessionHeader === undefined) {
        sendJson(response, 400, { error: 'MCP session ID required' });
        return;
      }
      if (sessionHeader !== undefined && (!sessionId || !sessions.has(sessionId))) {
        sendJson(response, 404, { error: 'MCP session not found' });
        return;
      }
      if (sessionId) {
        session = sessions.get(sessionId);
        if (!session || session.closed || session.terminating) {
          sendJson(response, 404, { error: 'MCP session not found' });
          return;
        }
        if (isDelete) {
          session.terminating = true;
          deletingSession = true;
        }
        if (session.idleTimer) clearTimeout(session.idleTimer);
        session.inFlight++;
      } else {
        if (sessions.size + pendingSessions >= maxSessions) {
          sendJson(response, 503, { error: 'MCP session capacity reached' });
          return;
        }
        pendingSessions++;
        creatingSession = true;
        const transport = new WebStandardStreamableHTTPServerTransport({
          sessionIdGenerator: randomUUID,
          enableJsonResponse: true,
          onsessioninitialized: (id) => {
            if (!session || session.closed) return;
            session.id = id;
            sessions.set(id, session);
          },
        });
        const mcp = createFusionMcpServer(sharedOptions, () => requestSignals.getStore());
        session = { mcp, transport, inFlight: 1, closed: false, terminating: false };
        await mcp.connect(transport);
      }
      const headers = new Headers();
      for (const [name, value] of Object.entries(request.headers))
        if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(', ') : value);
      const webRequest = new Request(`http://${request.headers.host}/mcp`, {
        method: request.method,
        headers,
        ...(!isDelete ? { body: JSON.stringify(body) } : {}),
        signal: controller.signal,
      });
      const result = await requestSignals.run(controller.signal, () =>
        session!.transport.handleRequest(webRequest, isDelete ? undefined : { parsedBody: body }),
      );
      if (isDelete && result.ok) await closeSession(session).catch(() => {});
      if (creatingSession) initializedSession = result.ok && result.headers.get('mcp-session-id') === session.id;
      const bytes = Buffer.from(await result.arrayBuffer());
      if (response.writableEnded || response.destroyed) return;
      // Own Node framing after the bounded body reader. Explicit chunking also
      // remains correct behind proxies that force chunked MCP responses.
      for (const [name, value] of result.headers)
        if (!['content-length', 'transfer-encoding', 'connection'].includes(name)) response.setHeader(name, value);
      response.setHeader('Transfer-Encoding', 'chunked');
      response.writeHead(result.status);
      response.end(bytes);
    } catch (error) {
      if (!response.headersSent)
        sendJson(response, error instanceof RangeError ? 413 : error instanceof SyntaxError ? 400 : 500, {
          error:
            error instanceof RangeError
              ? 'Request exceeds body limit'
              : error instanceof SyntaxError
                ? 'Invalid JSON'
                : 'MCP request failed',
        });
    } finally {
      active--;
      if (deleteMethod) activeDeletes--;
      if (creatingSession) pendingSessions--;
      if (session) {
        session.inFlight--;
        if (deletingSession && !session.closed) session.terminating = false;
        if (!session.id || (creatingSession && !initializedSession)) await closeSession(session).catch(() => {});
        else if (!session.closed && session.inFlight === 0) armSessionIdle(session);
      }
    }
  });
  server.once('close', () => {
    for (const session of sessions.values()) void closeSession(session).catch(() => {});
  });
  server.headersTimeout = Math.max(config.routing.totalTimeoutMs, 1000);
  server.requestTimeout = config.routing.totalTimeoutMs;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(http.port, http.host, () => {
      server.off('error', reject);
      resolve();
    });
  });
  return server;
}
