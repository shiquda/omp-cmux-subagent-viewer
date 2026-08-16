// Minimal type surface for the OMP extension API actually consumed by this
// extension. The real package is host-bundled and rewritten at load time;
// these declarations exist only so local typechecking/tests work standalone.
// Runtime access is via `pi.events` (the shared parent EventBus), verified
// empirically against omp 17.3.4 — see docs/omp-integration.md.

export interface ExtensionEventBus {
  on(channel: string, handler: (payload: unknown) => void): unknown;
  off?(channel: string, handler: (payload: unknown) => void): unknown;
  removeListener?(channel: string, handler: (payload: unknown) => void): unknown;
}

export interface ExtensionLogger {
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
  debug?(message: string, ...args: unknown[]): void;
}

export interface SessionManagerLike {
  getSessionId(): string | undefined;
  getSessionFile(): string | undefined;
}

export interface ExtensionContext {
  cwd: string;
  hasUI: boolean;
  sessionManager: SessionManagerLike;
  ui?: {
    notify?(message: string, kind?: string): void;
  };
  logger?: ExtensionLogger;
  setTimeout?(fn: (...args: unknown[]) => void, ms: number, ...args: unknown[]): unknown;
  setInterval?(fn: (...args: unknown[]) => void, ms: number, ...args: unknown[]): unknown;
  clearTimer?(handle: unknown): void;
}

export interface ExtensionAPI {
  events: ExtensionEventBus;
  logger: ExtensionLogger;
  on(event: string, handler: (event: unknown, ctx: ExtensionContext) => void | Promise<void>): unknown;
  getFlag?(name: string): unknown;
}

export type ExtensionFactory = (api: ExtensionAPI) => void | Promise<void>;
