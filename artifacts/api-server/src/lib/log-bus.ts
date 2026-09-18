import { EventEmitter } from "events";

export interface LogEntry {
  time: number;
  level: "INFO" | "WARN" | "ERROR" | "DEBUG" | "SYSTEM";
  msg: string;
  method?: string;
  url?: string;
  statusCode?: number;
  ms?: number;
  [key: string]: unknown;
}

class LogBus extends EventEmitter {
  private buffer: LogEntry[] = [];
  private readonly MAX = 500;

  push(entry: LogEntry) {
    this.buffer.push(entry);
    if (this.buffer.length > this.MAX) this.buffer.shift();
    this.emit("log", entry);
  }

  recent(n = 150): LogEntry[] {
    return this.buffer.slice(-n);
  }

  system(msg: string, extra?: Record<string, unknown>) {
    this.push({ time: Date.now(), level: "SYSTEM", msg, ...extra });
  }

  info(msg: string, extra?: Record<string, unknown>) {
    this.push({ time: Date.now(), level: "INFO", msg, ...extra });
  }

  warn(msg: string, extra?: Record<string, unknown>) {
    this.push({ time: Date.now(), level: "WARN", msg, ...extra });
  }

  error(msg: string, extra?: Record<string, unknown>) {
    this.push({ time: Date.now(), level: "ERROR", msg, ...extra });
  }
}

export const logBus = new LogBus();
