import type { AgentId } from '../types/index.js';

export type A2AMessageType =
  | 'request'
  | 'response'
  | 'broadcast'
  | 'subscribe'
  | 'unsubscribe'
  | 'heartbeat';

export interface A2AMessage {
  id: string;
  type: A2AMessageType;
  from: AgentId;
  to?: AgentId | 'broadcast';
  topic?: string;
  payload: unknown;
  correlationId?: string;
  timestamp: number;
  ttl?: number;
}

export interface A2ARequest extends A2AMessage {
  type: 'request';
  to: AgentId;
  command: string;
  params?: Record<string, unknown>;
}

export interface A2AResponse extends A2AMessage {
  type: 'response';
  correlationId: string;
  success: boolean;
  result?: unknown;
  error?: string;
}

export interface A2ABroadcast extends A2AMessage {
  type: 'broadcast';
  to: 'broadcast';
  topic: string;
}

export type A2AHandler = (msg: A2AMessage) => Promise<unknown>;
