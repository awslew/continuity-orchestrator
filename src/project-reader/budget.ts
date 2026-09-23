/**
 * Per-session work budget. The Chat client owns a finite context window and the
 * service cannot see how full it is, so the service measures the only thing it can
 * observe: how much text it has already sent back in this session. Reporting that
 * lets the caller see its own cost and choose a cheaper form (metadata instead of a
 * body, an anchor instead of a whole file) before the window is the thing that
 * ends the session.
 */
export type WorkBudgetSample = {
  calls: number;
  returned_chars: number;
  started_local: string;
  elapsed_minutes: number;
  average_chars_per_call: number | null;
  hint: string;
};

export class WorkBudget {
  private calls = 0;
  private chars = 0;
  private readonly started = Date.now();
  /** Approximate the text this result adds to the caller's context. Exactness is
   * not the point; the relative cost of one call against the rest is. */
  private static size(value: unknown): number {
    if (typeof value === "string") return value.length;
    if (value === null || value === undefined || typeof value !== "object") return 8;
    if (Array.isArray(value)) return value.reduce((total, item) => total + WorkBudget.size(item), 2);
    // JSON quoting and separators are real bytes; count keys too.
    return Object.entries(value as Record<string, unknown>).reduce((total, [key, item]) => total + key.length + WorkBudget.size(item) + 4, 2);
  }
  record(result: unknown): void {
    this.calls++;
    this.chars += WorkBudget.size(result);
  }
  sample(): WorkBudgetSample {
    const elapsedMs = Date.now() - this.started;
    const average = this.calls === 0 ? null : Math.round(this.chars / this.calls);
    return {
      calls: this.calls,
      returned_chars: this.chars,
      started_local: new Date(this.started).toISOString(),
      elapsed_minutes: Math.round(elapsedMs / 6000) / 10,
      average_chars_per_call: average,
      hint: this.hint(elapsedMs)
    };
  }
  /** Advice keyed to the two costs this service actually controls. The average is
   * per call, so the bar is a single ordinary whole-file round, not the biggest one. */
  private hint(elapsedMs: number): string {
    if (this.calls < 25) return "Budget is comfortable. Keep reading only what the current round needs.";
    const perMinute = elapsedMs > 0 ? this.calls / (elapsedMs / 60000) : 0;
    const parts = [`${this.calls} calls and about ${this.chars} characters returned so far.`];
    if (perMinute > 2) parts.push(`That is ${Math.round(perMinute)} calls per minute: batch independent reads into one call and prefer meta_only when you only need to confirm a hash.`);
    if (this.chars / Math.max(this.calls, 1) > 2000) parts.push("Average result size is large: quote anchors (old_string/new_string) instead of whole files, and read specific line ranges instead of whole files.");
    parts.push("Before the window fills, write your conclusions into the project and hand off through the plan document.");
    return parts.join(" ");
  }
}
