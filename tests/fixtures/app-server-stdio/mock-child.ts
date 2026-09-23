import type {
  AppServerRpcRequest,
  AppServerStdioEndpoint,
  AppServerStdioSpawn,
  AppServerStdioSpawnSpec
} from "../../../src/adapters/codex-app-server-stdio.js";

export type FixtureRequestHandler = (request: AppServerRpcRequest, child: FixtureAppServerChild) => void | Promise<void>;

/** In-memory NDJSON child used by the Wave B2 tests; it never starts a process. */
export class FixtureAppServerChild {
  readonly writes: string[] = [];
  readonly requests: AppServerRpcRequest[] = [];
  readonly receivedSpecs: AppServerStdioSpawnSpec[] = [];
  closed = false;
  killedWith: string | null = null;
  private readonly stdoutListeners = new Set<(chunk: unknown) => void>();
  private readonly stderrListeners = new Set<(chunk: unknown) => void>();
  private readonly exitListeners = new Set<(reason?: unknown) => void>();
  private readonly handler: FixtureRequestHandler;
  private exited = false;

  constructor(handler: FixtureRequestHandler) {
    this.handler = handler;
  }

  endpoint(): AppServerStdioEndpoint {
    return {
      write: (data) => this.write(data),
      onStdout: (listener) => { this.stdoutListeners.add(listener); return () => this.stdoutListeners.delete(listener); },
      onStderr: (listener) => { this.stderrListeners.add(listener); return () => this.stderrListeners.delete(listener); },
      onExit: (listener) => { this.exitListeners.add(listener); return () => this.exitListeners.delete(listener); },
      close: () => this.close(),
      kill: (signal) => this.kill(signal)
    };
  }

  private write(data: string): void {
    this.writes.push(data);
    for (const line of data.split(/\r?\n/)) {
      if (line.trim().length === 0) continue;
      const request = JSON.parse(line) as AppServerRpcRequest;
      this.requests.push(request);
      void this.handler(request, this);
    }
  }

  reply(requestId: number, result: unknown, options: { chunkSize?: number; delayMs?: number } = {}): void {
    const line = `${JSON.stringify({ jsonrpc: "2.0", id: requestId, result })}\n`;
    const deliver = (): void => {
      const chunkSize = options.chunkSize ?? line.length;
      for (let offset = 0; offset < line.length; offset += chunkSize) {
        const chunk = line.slice(offset, offset + chunkSize);
        for (const listener of this.stdoutListeners) listener(chunk);
      }
    };
    if (options.delayMs && options.delayMs > 0) setTimeout(deliver, options.delayMs);
    else deliver();
  }

  raw(message: unknown, options: { chunkSize?: number } = {}): void {
    const line = `${JSON.stringify(message)}\n`;
    const chunkSize = options.chunkSize ?? line.length;
    for (let offset = 0; offset < line.length; offset += chunkSize) {
      const chunk = line.slice(offset, offset + chunkSize);
      for (const listener of this.stdoutListeners) listener(chunk);
    }
  }

  error(requestId: number, code: string, message: string): void {
    const line = `${JSON.stringify({ jsonrpc: "2.0", id: requestId, error: { code, message } })}\n`;
    for (const listener of this.stdoutListeners) listener(line);
  }

  notification(method: string, params: unknown): void {
    const line = `${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`;
    for (const listener of this.stdoutListeners) listener(line);
  }

  stderr(value: string): void {
    for (const listener of this.stderrListeners) listener(value);
  }

  exit(reason: unknown = { code: 0, signal: null }): void {
    if (this.exited) return;
    this.exited = true;
    this.closed = true;
    for (const listener of this.exitListeners) listener(reason);
  }

  close(): void {
    this.exit({ code: 0, signal: null });
  }

  kill(signal = "SIGTERM"): void {
    this.killedWith = signal;
    this.exit({ code: null, signal });
  }
}

export function fixtureSpawn(child: FixtureAppServerChild, specs: AppServerStdioSpawnSpec[]): AppServerStdioSpawn {
  return (spec) => {
    specs.push({ ...spec, args: [...spec.args], env: { ...spec.env }, envAllowlist: [...spec.envAllowlist] });
    child.receivedSpecs.push(spec);
    return child.endpoint();
  };
}
