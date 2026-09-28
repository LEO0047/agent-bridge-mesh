import type { Agent } from '../messaging/protocol.js';
export interface TurnInput {
  collaboration_id: string;
  run_id: string;
  agent: Agent;
  session_id?: string;
  cwd: string;
  prompt: string;
  signal: AbortSignal;
  token: string;
  onSession: (id: string) => void;
  onEvent: (type: string, data: any) => void;
}
export interface Adapter {
  turn(input: TurnInput): Promise<{ summary: string; ready_for_next_phase: boolean }>;
}
