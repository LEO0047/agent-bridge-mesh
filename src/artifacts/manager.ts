import { mkdirSync, writeFileSync, renameSync, lstatSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { createTwoFilesPatch } from 'diff';
import { Store, id, now, hash } from '../database/sqlite.js';
import type { Config } from '../config.js';
export class Artifacts {
  constructor(
    public db: Store,
    public config: Config,
  ) {}
  read(c: string, name = 'draft.md') {
    return this.db.get('artifacts', `${c}/${name}`);
  }
  path(c: string, name: string) {
    if (
      !/^collab_[\w-]+$/.test(c) ||
      !/^([\w-]+\/)*[\w.-]+$/.test(name) ||
      name.split('/').some((s) => s === '..' || s === '.' || s.startsWith('.'))
    )
      throw Error('Invalid artifact path');
    const p = join(this.config.artifactsRoot, c, name);
    let at = this.config.artifactsRoot;
    for (const part of [c, ...name.split('/')]) {
      at = join(at, part);
      if (existsSync(at) && lstatSync(at).isSymbolicLink()) throw Error('Symlink forbidden');
    }
    return p;
  }
  export(c: string, name: string, content: string) {
    const p = this.path(c, name);
    mkdirSync(dirname(p), { recursive: true });
    const tmp = p + '.' + id('tmp');
    writeFileSync(tmp, content, { mode: 0o600 });
    renameSync(tmp, p);
    return p;
  }
  write(c: string, name: string, content: string, base: number, author: string, reason: string) {
    if (name === 'final.md') throw Error('final.md is owned by convergence engine');
    if (
      [
        'metadata.json',
        'disagreements.json',
        'decisions.json',
        'evidence/index.json',
        'best-effort.md',
      ].includes(name)
    )
      throw Error('Reserved Bridge export');
    if (Buffer.byteLength(content) > 2_000_000) throw Error('Artifact exceeds 2 MB');
    this.path(c, name);
    const a = this.db.tx(() => {
      const old = this.read(c, name);
      if ((old?.version || 0) !== base)
        throw Error(`STALE_VERSION: expected ${old?.version || 0}; read latest artifact`);
      const lease = this.db.db
        .prepare('SELECT * FROM leases WHERE id=? AND expires>?')
        .get(`${c}/${name}`, Date.now());
      if (lease && lease.owner !== author) throw Error('ARTIFACT_LOCKED');
      const value = {
        id: `${c}/${name}`,
        collaboration_id: c,
        name,
        version: base + 1,
        content,
        sha256: hash(content),
        author,
        reason,
        updated_at: now(),
      };
      this.db.put('artifact_versions', {
        ...value,
        id: `${c}/${name}/${value.version}`,
        base_version: base,
        new_version: value.version,
        diff: createTwoFilesPatch(name, name, old?.content || '', content),
        timestamp: now(),
      });
      this.db.put('artifacts', value);
      this.db.event(c, 'artifact.updated', {
        name,
        base_version: base,
        new_version: value.version,
        author,
      });
      return value;
    });
    this.export(c, name, content);
    return a;
  }
  patch(
    c: string,
    name: string,
    base: number,
    oldText: string,
    newText: string,
    author: string,
    reason: string,
  ) {
    const a = this.read(c, name);
    if (!a) throw Error('Artifact missing');
    if (!oldText || a.content.split(oldText).length !== 2)
      throw Error('Patch anchor must match exactly once');
    return this.write(c, name, a.content.replace(oldText, newText), base, author, reason);
  }
  section(
    c: string,
    name: string,
    base: number,
    heading: string,
    content: string,
    author: string,
    reason: string,
  ) {
    const a = this.read(c, name);
    if (!a) throw Error('Artifact missing');
    const lines = a.content.split('\n');
    const matches = lines
      .map((l: string, i: number) => (l === heading ? i : -1))
      .filter((i: number) => i >= 0);
    if (matches.length !== 1 || !/^#{1,6} /.test(heading))
      throw Error('Heading must match exactly once');
    const start = matches[0],
      level = heading.indexOf(' ');
    let end = start + 1;
    while (end < lines.length && !new RegExp(`^#{1,${level}} `).test(lines[end])) end++;
    lines.splice(start, end - start, heading, content, '');
    return this.write(c, name, lines.join('\n'), base, author, reason);
  }
  history(c: string, name = 'draft.md') {
    return this.db.all('artifact_versions', c).filter((a) => a.name === name);
  }
  lock(c: string, name: string, owner: string, ttl = 120000) {
    return this.db.tx(() => {
      const key = `${c}/${name}`,
        r = this.db.db.prepare('SELECT * FROM leases WHERE id=?').get(key);
      if (r && Number(r.expires) > Date.now() && r.owner !== owner) throw Error('ARTIFACT_LOCKED');
      this.db.db
        .prepare('INSERT OR REPLACE INTO leases VALUES(?,?,?)')
        .run(key, owner, Date.now() + Math.min(ttl, 300000));
      return { locked: true, owner };
    });
  }
  unlock(c: string, name: string, owner: string) {
    this.db.db.prepare('DELETE FROM leases WHERE id=? AND owner=?').run(`${c}/${name}`, owner);
    return { unlocked: true };
  }
}
