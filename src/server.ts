import { createServer, request as httpRequest } from 'node:http';
import { chmodSync, existsSync, unlinkSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { Store } from './database/sqlite.js';
import { Service } from './service.js';
import { Engine } from './collaboration-engine.js';
import type { Config } from './config.js';
export function masterToken(config: Config) {
  const path = join(config.state, 'access-token');
  if (!existsSync(path)) {
    try {
      writeFileSync(path, randomBytes(32).toString('hex'), { mode: 0o600, flag: 'wx' });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    }
  }
  return readFileSync(path, 'utf8').trim();
}
export async function request(
  config: Config,
  path: string,
  body?: any,
  token = process.env.AGENT_BRIDGE_CAPABILITY || masterToken(config),
): Promise<any> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        socketPath: config.socket,
        path,
        method: body ? 'POST' : 'GET',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      },
      (res) => {
        res.setEncoding('utf8');
        let data = '';
        res.on('data', (b) => (data += b));
        res.on('end', () => {
          try {
            const value = JSON.parse(data);
            res.statusCode! < 400 ? resolve(value) : reject(Error(value.error));
          } catch (e) {
            reject(e);
          }
        });
      },
    );
    req.on('error', reject);
    req.setTimeout(60000, () => req.destroy(Error('Bridge request timeout')));
    req.end(body ? JSON.stringify(body) : undefined);
  });
}
export async function serve(config: Config) {
  const lock = join(config.state, 'daemon.pid');
  if (existsSync(lock)) {
    const old = Number(readFileSync(lock, 'utf8'));
    let alive = false;
    try {
      process.kill(old, 0);
      alive = true;
    } catch {}
    if (alive) throw Error('A Bridge daemon already owns this state directory');
    unlinkSync(lock);
  }
  writeFileSync(lock, String(process.pid), { flag: 'wx', mode: 0o600 });
  if (existsSync(config.socket)) {
    try {
      await request(config, '/health');
      throw Error('ALREADY_RUNNING');
    } catch (e) {
      if (String(e).includes('ALREADY_RUNNING')) throw e;
      unlinkSync(config.socket);
    }
  }
  const db = new Store(config.db),
    service = new Service(db, config),
    engine = new Engine(service),
    token = masterToken(config);
  const server = createServer(async (req, res) => {
    res.setHeader('content-type', 'application/json');
    try {
      const provided = (req.headers.authorization || '').replace(/^Bearer /, '');
      const admin =
        provided.length === token.length &&
        timingSafeEqual(Buffer.from(provided), Buffer.from(token));
      const ctx = engine.capabilities.get(provided);
      if (!admin && !ctx) {
        res.writeHead(401);
        res.end(JSON.stringify({ error: 'Invalid or expired capability' }));
        return;
      }
      const url = new URL(req.url!, 'http://localhost');
      let output: any;
      if (url.pathname === '/health')
        output = { status: 'ok', pid: process.pid, active: engine.running.size };
      else if (url.pathname === '/rpc' && req.method === 'POST') {
        req.setEncoding('utf8');
        let raw = '';
        for await (const chunk of req) {
          raw += chunk;
          if (raw.length > 3_000_000) throw Error('Request too large');
        }
        const { name, args = {}, collaboration_id } = JSON.parse(raw);
        if (ctx && collaboration_id && collaboration_id !== ctx.collaboration_id)
          throw Error('Cross-collaboration access denied');
        output = await service.call(name, args, admin ? { actor: 'user', collaboration_id } : ctx!);
      } else if (admin && url.pathname === '/collaborations') output = db.all('collaborations');
      else if (admin && url.pathname.startsWith('/collaborations/'))
        output = service.status(url.pathname.split('/')[2]!);
      else if (admin && url.pathname === '/messages')
        output = db.all('messages', url.searchParams.get('id') || undefined);
      else if (admin && url.pathname === '/events')
        output = db.events(
          url.searchParams.get('id') || undefined,
          Number(url.searchParams.get('after') || 0),
        );
      else if (admin && url.pathname === '/artifact')
        output = service.artifacts.read(
          url.searchParams.get('id')!,
          url.searchParams.get('name') || 'draft.md',
        );
      else if (admin && url.pathname === '/disagreements')
        output = db.all('disagreements', url.searchParams.get('id') || undefined);
      else if (admin && url.pathname === '/stop' && req.method === 'POST') {
        output = { stopping: true };
        setTimeout(() => shutdown(), 50);
      } else {
        res.writeHead(404);
        output = { error: 'Not found' };
      }
      res.end(JSON.stringify(output));
    } catch (e) {
      res.writeHead(400);
      res.end(JSON.stringify({ error: String(e) }));
    }
  });
  const shutdown = () => {
    engine.stopping = true;
    for (const c of engine.running.values()) c.abort();
    server.close(() => {
      try {
        unlinkSync(config.socket);
        unlinkSync(lock);
      } catch {}
      setTimeout(() => process.exit(0), 500);
    });
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.socket, () => {
      chmodSync(config.socket, 0o600);
      resolve();
    });
  });
  engine.recover();
  return { server, service, engine };
}
