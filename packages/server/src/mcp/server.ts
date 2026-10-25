// @bom 认知访问层/MCP协议服务 — stdio MCP server（全局模式）
/**
 * MCP Server with stdio transport (for local CLI usage).
 * Exposes all tools with an optional project param (global mode).
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ProjectManager } from '../projects/index.js';
import { registerTools } from './tools.js';

// ============================================================
// Initialization
// ============================================================

const manager = new ProjectManager();

const server = new McpServer({
  name: 'si-beaver',
  version: '0.2.0',
});

registerTools(server, { mode: 'global', manager });

// ============================================================
// Start
// ============================================================

// @sibom r-mp1a — stdio 传输承载标准 MCP 协议，本地 CLI 无需定制客户端即可接入
async function main() {
  await manager.init();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('si-beaver MCP server started (stdio, multi-project)');
}

main().catch(console.error);
