import { killGroup, processIdentity } from './process.js';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import type { Adapter, TurnInput } from './types.js';
import type { Config } from '../config.js';
import { TurnResult, turnSchema } from '../messaging/protocol.js';
import { safeEnvironment } from '../policy/permissions.js';
export class ClaudeAdapter implements Adapter {
  constructor(private config: Config) {}
  async turn(input: TurnInput) {
    const mcp = {
      mcpServers: {
        'agent-bridge': {
          command: process.execPath,
          args: [join(this.config.root, 'dist', 'cli.js'), 'mcp', '--agent', 'claude'],
          env: {
            AGENT_BRIDGE_ROOT: this.config.root,
            AGENT_BRIDGE_STATE: this.config.state,
            AGENT_BRIDGE_CAPABILITY: input.token,
          },
        },
      },
    };
    const args = [
      '-p',
      '--output-format',
      'stream-json',
      '--verbose',
      '--json-schema',
      JSON.stringify(turnSchema),
      '--permission-mode',
      'dontAsk',
      '--tools',
      'WebSearch,WebFetch',
      '--allowedTools',
      'WebSearch,WebFetch,mcp__agent-bridge__*',
      '--strict-mcp-config',
      '--mcp-config',
      JSON.stringify(mcp),
      '--setting-sources',
      '',
      '--settings',
      JSON.stringify({ disableAllHooks: true }),
      '--disable-slash-commands',
    ];
    if (input.session_id) args.push('--resume', input.session_id);
    if (this.config.agents.claude.model) args.push('--model', this.config.agents.claude.model);
    const child = spawn(this.config.agents.claude.command, args, {
      cwd: input.cwd,
      env: safeEnvironment(),
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true,
    });
    if (child.pid)
      input.onEvent('process.started', { pid: child.pid, identity: processIdentity(child.pid) });
    let stderr = '',
      result: any;
    const stop = () => {
      killGroup(child, 'SIGINT');
      const timer = setTimeout(() => killGroup(child, 'SIGKILL'), 3000);
      timer.unref();
    };
    input.signal.addEventListener('abort', stop, { once: true });
    try {
      return await new Promise<ReturnType<typeof TurnResult.parse>>((resolve, reject) => {
        child.stderr.on('data', (b) => {
          stderr = (stderr + b).slice(-12000);
        });
        child.on('error', reject);
        child.stdin.on('error', reject);
        createInterface({ input: child.stdout }).on('line', (line) => {
          try {
            const msg = JSON.parse(line);
            if (msg.session_id) input.onSession(msg.session_id);
            if (['system', 'assistant', 'user', 'result'].includes(msg.type))
              input.onEvent(msg.type, msg);
            if (msg.type === 'result') result = msg;
          } catch (e) {
            reject(e);
          }
        });
        child.on('exit', (code) => {
          if (input.signal.aborted) return reject(Error('Agent interrupted'));
          if (code !== 0 || !result || result.is_error)
            return reject(
              Error(`Claude failed (${code}): ${JSON.stringify(result || stderr).slice(-4000)}`),
            );
          try {
            resolve(TurnResult.parse(result.structured_output || JSON.parse(result.result)));
          } catch (e) {
            reject(Error(`Invalid Claude structured result: ${String(e)}`));
          }
        });
        child.stdin.end(input.prompt);
      });
    } finally {
      input.signal.removeEventListener('abort', stop);
      if (child.exitCode === null) stop();
    }
  }
}
