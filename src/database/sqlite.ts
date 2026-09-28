import { DatabaseSync } from 'node:sqlite';
import { randomUUID, createHash } from 'node:crypto';
export const id = (prefix: string) => `${prefix}_${randomUUID()}`;
export const now = () => new Date().toISOString();
export const hash = (v: string) => createHash('sha256').update(v).digest('hex');
export class Store {
  db: DatabaseSync;
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS records(kind TEXT NOT NULL,id TEXT NOT NULL,collab TEXT NOT NULL,json TEXT NOT NULL,PRIMARY KEY(kind,id));
    CREATE INDEX IF NOT EXISTS records_collab ON records(kind,collab);
    CREATE TABLE IF NOT EXISTS events(seq INTEGER PRIMARY KEY AUTOINCREMENT,collab TEXT NOT NULL,type TEXT NOT NULL,json TEXT NOT NULL,created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS leases(id TEXT PRIMARY KEY,owner TEXT NOT NULL,expires INTEGER NOT NULL);
    PRAGMA user_version=1;`);
    // Named, queryable views provide an intentionally small persistence layer.
    for (const name of [
      'collaborations',
      'agents',
      'sessions',
      'tasks',
      'messages',
      'artifacts',
      'artifact_versions',
      'reviews',
      'disagreements',
      'decisions',
      'runs',
      'test_runs',
      'evidence',
      'comments',
    ])
      this.db.exec(
        `CREATE VIEW IF NOT EXISTS ${name} AS SELECT id,collab,json FROM records WHERE kind='${name}'`,
      );
  }
  get<T = any>(kind: string, id: string): T | undefined {
    const r = this.db.prepare('SELECT json FROM records WHERE kind=? AND id=?').get(kind, id);
    return r ? JSON.parse(r.json as string) : undefined;
  }
  all<T = any>(kind: string, collab?: string): T[] {
    const rows =
      collab === undefined
        ? this.db.prepare('SELECT json FROM records WHERE kind=? ORDER BY rowid').all(kind)
        : this.db
            .prepare('SELECT json FROM records WHERE kind=? AND collab=? ORDER BY rowid')
            .all(kind, collab);
    return rows.map((r) => JSON.parse(r.json as string));
  }
  put(kind: string, value: { id: string; collaboration_id?: string; [key: string]: any }) {
    this.db
      .prepare(
        'INSERT INTO records VALUES(?,?,?,?) ON CONFLICT(kind,id) DO UPDATE SET json=excluded.json,collab=excluded.collab',
      )
      .run(kind, value.id, value.collaboration_id || value.id, JSON.stringify(value));
    return value;
  }
  event(collab: string, type: string, data: unknown) {
    this.db
      .prepare('INSERT INTO events(collab,type,json,created_at) VALUES(?,?,?,?)')
      .run(collab, type, JSON.stringify(data), now());
  }
  events(collab?: string, after = 0) {
    return (
      collab
        ? this.db
            .prepare('SELECT * FROM events WHERE collab=? AND seq>? ORDER BY seq')
            .all(collab, after)
        : this.db.prepare('SELECT * FROM events WHERE seq>? ORDER BY seq').all(after)
    ).map((r) => ({ ...r, data: JSON.parse(r.json as string), json: undefined }));
  }
  tx<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const r = fn();
      this.db.exec('COMMIT');
      return r;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }
  close() {
    this.db.close();
  }
}
