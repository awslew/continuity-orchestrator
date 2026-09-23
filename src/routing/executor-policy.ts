import { DomainError } from "../domain/errors.js";

export type ExecutorName = "codex" | "luna" | "claude" | "dsh" | "bridge-dsh";
export type ContinuationSemantic = "claude_resume" | "dsh_fresh";

export interface ExecutorRequest {
  executor: ExecutorName;
  continuation: ContinuationSemantic;
  source: "claude_orchestrator" | "engineering-bridge";
  quotaDepleted: boolean;
}

export interface ExecutorDecision {
  allowed: true;
  executor: ExecutorName;
  continuation: ContinuationSemantic;
  explicit: true;
}

export function validateExecutorRequest(request: ExecutorRequest): ExecutorDecision {
  if (request.quotaDepleted && (request.executor === "codex" || request.executor === "luna")) {
    throw new DomainError("ROUTING_REJECTED", "Codex and Luna are disabled while Codex quota is depleted");
  }
  if (request.source === "engineering-bridge" && request.executor !== "dsh") {
    throw new DomainError("ROUTING_REJECTED", "Engineering Bridge relay calls require explicit executor:dsh");
  }
  if (request.executor === "bridge-dsh") {
    throw new DomainError("ROUTING_REJECTED", "bridge-dsh is an internal worker kind; wire executor must be explicit dsh");
  }
  if (request.executor === "dsh" && request.continuation !== "dsh_fresh") {
    throw new DomainError("ROUTING_REJECTED", "DSH calls are fresh turns, never resume");
  }
  if (request.executor === "claude" && (request.source !== "claude_orchestrator" || request.continuation !== "claude_resume")) {
    throw new DomainError("ROUTING_REJECTED", "Claude continuation must be a real claude_orchestrator resume");
  }
  if (request.executor === "codex" && request.continuation !== "claude_resume") {
    throw new DomainError("ROUTING_REJECTED", "Codex executor cannot be represented as a DSH fresh turn");
  }
  return { allowed: true, executor: request.executor, continuation: request.continuation, explicit: true };
}

export function canRouteExecutor(request: ExecutorRequest): boolean {
  try {
    validateExecutorRequest(request);
    return true;
  } catch (error) {
    if (error instanceof DomainError && error.code === "ROUTING_REJECTED") return false;
    throw error;
  }
}

export function assertExplicitDsh(executor: string | undefined): asserts executor is "dsh" {
  if (executor !== "dsh") throw new DomainError("ROUTING_REJECTED", "DSH executor must be explicit executor:dsh");
}
