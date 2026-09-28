import { killGroup, processIdentity } from './process.js';
import { spawn, spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { zodToJsonSchema } from 'zod-to-json-schema';
import type { Adapter, TurnInput } from './types.js';
import type { Service } from '../service.js';
import { toolDefinitions } from '../tools.js';
import { TurnResult, turnSchema } from '../messaging/protocol.js';
import { safeEnvironment } from '../policy/permissions.js';

export class CodexAdapter implements Adapter {
  constructor(private service: Service) {}
  async turn(input: TurnInput) {
    const command = this.service.config.agents.codex.command;
    const args = [
      'app-server',
      '--listen',
      'stdio://',
      '-c',
      'features.shell_tool=false',
      '-c',
      'features.apply_patch_freeform=false',
      '-c',
      'features.multi_agent=false',
      '-c',
      'features.js_repl=false',
      '-c',
      'web_search="live"',
    ];
    // Replace the child runtime's MCP table; never alter the user's configuration.
    args.push('-c', 'mcp_servers={}');
    const child = spawn(command, args, {
      cwd: input.cwd,
      env: safeEnvironment(),
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true,
    });
    if (child.pid)
      input.onEvent('process.started', { pid: child.pid, identity: processIdentity(child.pid) });
    let seq = 0,
      threadId = input.session_id,
      turnId: string | undefined,
      final = '',
      stderr = '';
    const pending = new Map<number, { resolve: (x: any) => void; reject: (e: Error) => void }>();
    let finish!: (x: any) => void, fail!: (e: Error) => void;
    const result = new Promise<any>((resolve, reject) => {
      finish = resolve;
      fail = reject;
    });
    result.catch(() => {});
    child.stdin.on('error', (e) => fail(e));
    const send = (v: any) => {
      if (!child.stdin.destroyed) child.stdin.write(JSON.stringify(v) + '\n');
    };
    const rpc = (method: string, params: any) =>
      new Promise<any>((resolve, reject) => {
        const id = ++seq;
        pending.set(id, { resolve, reject });
        send({ id, method, params });
      });
    child.stderr.on('data', (b) => {
      stderr = (stderr + b).slice(-12000);
    });
    child.on('error', (e) => {
      for (const p of pending.values()) p.reject(e);
      fail(e);
    });
    child.on('exit', (code) => {
      const e = Error(`Codex process exited ${code}: ${stderr.slice(-2000)}`);
      for (const p of pending.values()) p.reject(e);
      pending.clear();
      fail(e);
    });
    const stop = () => {
      if (threadId && turnId)
        send({ id: ++seq, method: 'turn/interrupt', params: { threadId, turnId } });
      killGroup(child, 'SIGTERM');
      const timer = setTimeout(() => killGroup(child, 'SIGKILL'), 3000);
      timer.unref();
      fail(Error('Agent interrupted'));
    };
    input.signal.addEventListener('abort', stop, { once: true });
    createInterface({ input: child.stdout }).on('line', async (line) => {
      try {
        const msg = JSON.parse(line);
        if (msg.id !== undefined && !msg.method) {
          const p = pending.get(msg.id);
          if (p) {
            pending.delete(msg.id);
            msg.error ? p.reject(Error(JSON.stringify(msg.error))) : p.resolve(msg.result);
          }
          return;
        }
        if (msg.id !== undefined && msg.method) {
          if (msg.method === 'item/tool/call') {
            try {
              const value = await this.service.call(msg.params.tool, msg.params.arguments, {
                actor: 'codex',
                collaboration_id: input.collaboration_id,
                run_id: input.run_id,
              });
              send({
                id: msg.id,
                result: {
                  success: true,
                  contentItems: [{ type: 'inputText', text: JSON.stringify(value) }],
                },
              });
            } catch (e) {
              send({
                id: msg.id,
                result: { success: false, contentItems: [{ type: 'inputText', text: String(e) }] },
              });
            }
          } else if (msg.method.includes('requestApproval'))
            send({ id: msg.id, result: { decision: 'decline' } });
          else
            send({
              id: msg.id,
              error: {
                code: -32601,
                message: 'Bridge denies unsupported interactive or privileged operation',
              },
            });
          return;
        }
        if (
          [
            'item/completed',
            'turn/started',
            'turn/completed',
            'error',
            'thread/tokenUsage/updated',
          ].includes(msg.method)
        )
          input.onEvent(msg.method, msg.params);
        if (msg.method === 'turn/started') turnId = msg.params.turn.id;
        if (msg.method === 'item/completed' && msg.params.item?.type === 'agentMessage')
          final = msg.params.item.text;
        if (msg.method === 'turn/completed') {
          if (msg.params.turn.status === 'completed') {
            try {
              finish(TurnResult.parse(JSON.parse(final)));
            } catch (e) {
              fail(Error(`Invalid Codex structured result: ${String(e)}; ${final.slice(0, 500)}`));
            }
          } else fail(Error(JSON.stringify(msg.params.turn.error || msg.params.turn)));
        }
      } catch (e) {
        fail(e as Error);
      }
    });
    try {
      await rpc('initialize', {
        clientInfo: { name: 'agent_bridge', version: '1.0.0' },
        capabilities: { experimentalApi: true },
      });
      send({ method: 'initialized', params: {} });
      const params: any = {
        cwd: input.cwd,
        approvalPolicy: 'never',
        sandbox: 'read-only',
        developerInstructions: input.prompt.split('\nCURRENT TURN:')[0],
        config: {
          'features.shell_tool': false,
          'features.apply_patch_freeform': false,
          'features.multi_agent': false,
          'features.js_repl': false,
          web_search: 'live',
        },
      };
      if (this.service.config.agents.codex.model)
        params.model = this.service.config.agents.codex.model;
      if (threadId) {
        const r = await rpc('thread/resume', { ...params, threadId });
        threadId = r.thread.id;
        input.onEvent('session.config', { model: r.model, modelProvider: r.modelProvider });
      } else {
        params.dynamicTools = toolDefinitions(true).map((t) => ({
          type: 'function',
          name: t.name,
          description: t.description,
          inputSchema: zodToJsonSchema(t.schema, { $refStrategy: 'none' }),
        }));
        const r = await rpc('thread/start', params);
        threadId = r.thread.id;
        input.onEvent('session.config', { model: r.model, modelProvider: r.modelProvider });
      }
      input.onSession(threadId!);
      await rpc('turn/start', {
        threadId,
        input: [{ type: 'text', text: input.prompt }],
        outputSchema: turnSchema,
      });
      return await result;
    } finally {
      input.signal.removeEventListener('abort', stop);
      killGroup(child, 'SIGTERM');
      const timer = setTimeout(() => killGroup(child, 'SIGKILL'), 3000);
      timer.unref();
    }
  }
}
