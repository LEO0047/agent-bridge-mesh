import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { toolDefinitions } from './tools.js';
import { request } from './server.js';
import type { Config } from './config.js';
export async function mcp(config: Config, agent?: string) {
  const server = new McpServer({ name: 'agent-bridge', version: '1.0.0' });
  for (const t of toolDefinitions(!!agent)) {
    const shape = agent
      ? t.schema.shape
      : {
          ...t.schema.shape,
          ...(t.name === 'collaboration_start' ? {} : { collaboration_id: z.string() }),
        };
    server.registerTool(
      t.name,
      { description: t.description, inputSchema: shape },
      async (args: any) => {
        try {
          const { collaboration_id, ...rest } = args;
          const value = await request(config, '/rpc', {
            name: t.name,
            args: rest,
            collaboration_id,
          });
          return {
            content: [
              { type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) },
            ],
          };
        } catch (e) {
          return { isError: true, content: [{ type: 'text', text: String(e) }] };
        }
      },
    );
  }
  await server.connect(new StdioServerTransport());
}
