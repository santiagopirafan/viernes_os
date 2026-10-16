import { EventEmitter } from "node:events";

export type RiskLevel = "green" | "yellow" | "red";

export interface BaseEvent {
  ts: number;
  channel?: string;
}

export interface LogEvent extends BaseEvent {
  type: "log";
  level: "info" | "warn" | "error";
  message: string;
  meta?: Record<string, unknown>;
}

export interface MessageEvent extends BaseEvent {
  type: "message:in" | "message:out";
  content: string;
}

export interface ToolEvent extends BaseEvent {
  type: "tool:executed" | "tool:blocked";
  tool: string;
  risk: RiskLevel;
  detail?: string;
}

export interface RiskEvent extends BaseEvent {
  type: "risk:blocked";
  reason: string;
}

export type ViernesEvent = LogEvent | MessageEvent | ToolEvent | RiskEvent;

export type ViernesEventType = ViernesEvent["type"] | "*";

class TypedEventBus extends EventEmitter {
  publish(event: ViernesEvent): void {
    this.emit(event.type, event);
    this.emit("*", event);
  }

  onEvent(type: ViernesEventType, listener: (event: ViernesEvent) => void): void {
    this.on(type, listener);
  }
}

export const events = new TypedEventBus();
