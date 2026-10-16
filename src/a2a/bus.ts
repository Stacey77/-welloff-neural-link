import { randomUUID } from 'crypto';
import type { AgentId } from '../types/index.js';
import type { A2AMessage, A2ARequest, A2AResponse, A2AHandler } from './protocol.js';

type TopicHandler = (msg: A2AMessage) => void;

class A2ABus {
  private handlers = new Map<AgentId, A2AHandler>();
  private topicSubs = new Map<string, Set<AgentId>>();
  private topicHandlers = new Map<string, Set<TopicHandler>>();
  private messageLog: A2AMessage[] = [];
  private readonly MAX_LOG = 500;

  register(agentId: AgentId, handler: A2AHandler): void {
    this.handlers.set(agentId, handler);
  }

  unregister(agentId: AgentId): void {
    this.handlers.delete(agentId);
  }

  subscribe(agentId: AgentId, topic: string): void {
    if (!this.topicSubs.has(topic)) this.topicSubs.set(topic, new Set());
    this.topicSubs.get(topic)!.add(agentId);
  }

  onTopic(topic: string, handler: TopicHandler): () => void {
    if (!this.topicHandlers.has(topic)) this.topicHandlers.set(topic, new Set());
    this.topicHandlers.get(topic)!.add(handler);
    return () => this.topicHandlers.get(topic)?.delete(handler);
  }

  async send(req: Omit<A2ARequest, 'id' | 'timestamp'>): Promise<A2AResponse> {
    const msg: A2ARequest = { ...req, id: randomUUID(), timestamp: Date.now() };
    this.log(msg);

    const handler = this.handlers.get(req.to);
    if (!handler) {
      return {
        id: randomUUID(), type: 'response', from: req.to, to: req.from,
        correlationId: msg.id, success: false,
        error: `Agent ${req.to} is not registered on the bus`,
        payload: null, timestamp: Date.now(),
      };
    }

    try {
      const result = await handler(msg);
      const resp: A2AResponse = {
        id: randomUUID(), type: 'response', from: req.to, to: req.from,
        correlationId: msg.id, success: true, result,
        payload: result, timestamp: Date.now(),
      };
      this.log(resp);
      return resp;
    } catch (err) {
      const resp: A2AResponse = {
        id: randomUUID(), type: 'response', from: req.to, to: req.from,
        correlationId: msg.id, success: false,
        error: err instanceof Error ? err.message : String(err),
        payload: null, timestamp: Date.now(),
      };
      this.log(resp);
      return resp;
    }
  }

  broadcast(from: AgentId, topic: string, payload: unknown): void {
    const msg: A2AMessage = {
      id: randomUUID(), type: 'broadcast', from, to: 'broadcast',
      topic, payload, timestamp: Date.now(),
    };
    this.log(msg);

    const topicHandlers = this.topicHandlers.get(topic);
    if (topicHandlers) {
      for (const handler of topicHandlers) handler(msg);
    }

    const subscribers = this.topicSubs.get(topic);
    if (!subscribers) return;

    for (const agentId of subscribers) {
      const handler = this.handlers.get(agentId);
      if (handler) handler(msg).catch(() => {});
    }
  }

  getLog(limit = 50): A2AMessage[] {
    return this.messageLog.slice(-limit);
  }

  private log(msg: A2AMessage): void {
    this.messageLog.push(msg);
    if (this.messageLog.length > this.MAX_LOG) {
      this.messageLog.splice(0, this.messageLog.length - this.MAX_LOG);
    }
  }
}

export const a2aBus = new A2ABus();
