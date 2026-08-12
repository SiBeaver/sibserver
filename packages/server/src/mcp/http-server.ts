/**
 * MCP Server with Streamable HTTP transport.
 * Routes: /{slug}/mcp — each slug gets a project-scoped MCP server.
 * Unknown slugs get a degraded session with only `initialize_project`.
 *
 * This module exports a handler function; it no longer starts its own server.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { ProjectManager } from '../projects/index.js';
import { createDegradedServer } from './degraded-session.js';
import { registerTools } from './tools.js';

// ============================================================
// Per-session MCP server factory
// ============================================================

async function createServerForSlug(manager: ProjectManager, slug: string): Promise<McpServer | null> {
  const project = await manager.getProject(slug);
  if (!project) return null;

  const server = new McpServer({
    name: `si-beaver/${slug}`,
    version: '0.2.0',
  });

  registerTools(server, {
    mode: 'scoped',
    slug,
    getContext: () => manager.getContext(slug),
    getMetadata: () => project.metadata,
  });

  return server;
}

// ============================================================
// Session management
// ============================================================

const SESSION_IDLE_TTL = 600_000; // 10 minutes grace period after transport close

interface SessionEntry {
  transport: StreamableHTTPServerTransport;
  slug: string;
  degraded?: boolean;
  closeTimer?: ReturnType<typeof setTimeout>;
}

const sessions = new Map<string, SessionEntry>();

function clearSessionTimer(entry: SessionEntry): void {
  if (entry.closeTimer) {
    clearTimeout(entry.closeTimer);
    entry.closeTimer = undefined;
  }
}

function scheduleSessionCleanup(sid: string, entry: SessionEntry): void {
  entry.closeTimer = setTimeout(() => {
    console.log(`[MCP] session expired (idle) slug="${entry.slug}" session="${sid}"`);
    sessions.delete(sid);
  }, SESSION_IDLE_TTL);
}

// ============================================================
// Exported handler
// ============================================================

const SLUG_PATTERN = /^\/([a-z0-9][a-z0-9-]*[a-z0-9]|[a-z0-9])\/mcp$/;

/**
 * Handle an incoming request on `/{slug}/mcp`.
 * Returns true if the request was handled, false if the path didn't match.
 */
export async function handleMcpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  manager: ProjectManager,
): Promise<boolean> {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

  const match = SLUG_PATTERN.exec(url.pathname);
  if (!match) return false;

  const slug = match[1];
  const sessionId = req.headers['mcp-session-id'] as string | undefined;

  if (req.method === 'POST' || req.method === 'GET') {
    let entry: SessionEntry | undefined;
    let isNewSession = false;

    if (sessionId && sessions.has(sessionId)) {
      entry = sessions.get(sessionId)!;
      if (entry.slug !== slug) {
        // session 属于其他项目，不能跨项目复用 —— 视为失效，客户端重新初始化
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Session not found', code: 'SESSION_EXPIRED' }));
        return true;
      }
      clearSessionTimer(entry);
    } else if (sessionId) {
      // Session expired or unknown — return 404 per MCP spec so client re-initializes
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Session not found', code: 'SESSION_EXPIRED' }));
      return true;
    } else if (!sessionId && req.method === 'POST') {
      let server = await createServerForSlug(manager, slug);
      const degraded = !server;
      if (!server) {
        server = createDegradedServer(manager, slug);
      }
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => crypto.randomUUID(),
      });
      transport.onclose = () => {
        if (transport.sessionId) {
          console.log(`[MCP] session transport closed slug="${slug}" session="${transport.sessionId}"`);
          scheduleSessionCleanup(transport.sessionId, entry!);
        }
      };
      await server.connect(transport);
      entry = { transport, slug, degraded };
      isNewSession = true;
    } else {
      // GET without session ID — invalid request
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing session ID' }));
      return true;
    }

    try {
      await entry.transport.handleRequest(req, res);
    } catch (err) {
      console.error(`[MCP] transport error for slug="${slug}" session="${sessionId}":`, err);
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Internal server error' }));
      }
      return true;
    }

    if (isNewSession && entry.transport.sessionId) {
      sessions.set(entry.transport.sessionId, entry);
      console.log(`[MCP] session created slug="${slug}" session="${entry.transport.sessionId}" ${entry.degraded ? 'degraded' : 'full'}`);
    }
    return true;
  }

  if (req.method === 'DELETE') {
    if (sessionId && sessions.has(sessionId)) {
      const entry = sessions.get(sessionId)!;
      clearSessionTimer(entry);
      await entry.transport.handleRequest(req, res);
      sessions.delete(sessionId);
    } else {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Session not found' }));
    }
    return true;
  }

  res.writeHead(405);
  res.end('Method Not Allowed');
  return true;
}

export { sessions };
