import { Store, id, now } from '../database/sqlite.js';
import { MessageInput, peer, type Agent } from './protocol.js';
import { fingerprint, similarity } from '../policy/loop-protection.js';
export class Bus {
  constructor(
    public db: Store,
    public maxDuplicates = 2,
  ) {}
  send(c: string, from: Agent, input: unknown) {
    const x = MessageInput.parse(input);
    const history = this.db.all('messages', c);
    if (x.reply_to) {
      const original = history.find((m) => m.message_id === x.reply_to);
      if (!original || original.to !== from || original.from !== peer(from))
        throw Error('Reply must reference a message sent to this agent');
    }
    for (const e of x.evidence_refs)
      if (!this.db.get('evidence', e) || this.db.get('evidence', e).collaboration_id !== c)
        throw Error('Unknown evidence reference');
    const duplicates = history.filter(
      (m) =>
        m.from === from &&
        m.type === x.type &&
        (m.hash === fingerprint(x.content) || similarity(m.content, x.content) > 0.91),
    );
    if (duplicates.length >= this.maxDuplicates)
      throw Error('DUPLICATE_MESSAGE: provide new evidence, question, decision or change');
    const mid = id('msg'),
      m = {
        ...x,
        id: mid,
        message_id: mid,
        conversation_id: c,
        root_task_id: c,
        collaboration_id: c,
        from,
        to: peer(from),
        created_at: now(),
        hash: fingerprint(x.content),
        resolved: false,
      };
    this.db.tx(() => {
      this.db.put('messages', m);
      if (x.reply_to) {
        const original = this.db.get('messages', x.reply_to);
        this.db.put('messages', { ...original, resolved: true, resolved_by: mid });
      }
      this.db.event(c, 'peer.message', m);
    });
    return m;
  }
  pending(c: string, agent?: Agent) {
    return this.db
      .all('messages', c)
      .filter((m) => m.requires_reply && !m.resolved && (!agent || m.to === agent));
  }
}
