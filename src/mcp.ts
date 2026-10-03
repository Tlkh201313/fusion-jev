/** Public MCP surface. The implementation lives in ./mcp/: server wiring, one module per tool group, and the HTTP endpoint. */
export { createFusionMcpServer, startStdioServer } from './mcp/server.js';
export { startHttpServer, validateHttpConfig } from './mcp/http.js';
export { mcpToolNames } from './mcp/catalog.js';
export type { McpOptions, RoutingService } from './mcp/context.js';
