// Author: Jeff.Liu. One bounded active-project reader; no launch or Git mutation.
export type GitContext = {
  kind: "repository" | "detached" | "not_repository" | "unavailable";
  branch: string | null;
  dirty: boolean | null;
  root: string | null;
  common_dir: string | null;
  code?: string;
};
const errorCodes = new Set(["git_attributes_unsupported", "git_submodule_unavailable", "git_busy", "git_missing", "git_invalid_path", "git_timeout", "git_output_limit", "git_external_filter", "git_environment", "git_context_changed", "git_query_failed", "git_conversion_unsupported"]);
export function isGitContext(value: unknown): value is GitContext {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  if (Object.keys(item).some(key => !["kind", "branch", "dirty", "root", "common_dir", "code"].includes(key))) return false;
  if (item.kind === "unavailable" || item.kind === "not_repository") {
    return item.branch === null && item.dirty === null && item.root === null && item.common_dir === null &&
      (item.kind === "not_repository" ? item.code === undefined : typeof item.code === "string" && errorCodes.has(item.code));
  }
  return (item.kind === "repository" || item.kind === "detached") &&
    (item.kind === "repository" ? typeof item.branch === "string" && item.branch.length > 0 && item.branch.length <= 4096 : item.branch === null) &&
    typeof item.dirty === "boolean" && typeof item.root === "string" && item.root.length > 0 && item.root.length <= 4096 &&
    typeof item.common_dir === "string" && item.common_dir.length > 0 && item.common_dir.length <= 4096 && item.code === undefined;
}
export function gitContextLabel(value: GitContext): string {
  if (value.kind === "unavailable") return "Git status unavailable";
  if (value.kind === "not_repository") return "Not a Git repository";
  return `${value.branch ?? "Detached HEAD"} · ${value.dirty ? "dirty" : "clean"}`;
}
function unavailable(reason: unknown): GitContext {
  return {kind: "unavailable", code: typeof reason === "string" && errorCodes.has(reason) ? reason : "git_query_failed", branch: null, dirty: null, root: null, common_dir: null};
}
export class GitContextPolling {
  private path = "";
  private owner = "";
  private generation = 0;
  private inFlight = false;
  private lastStarted = new Map<string, number>();
  private previous: GitContext | null = null;
  select(path: string, owner: string): void {
    if (path === this.path && owner === this.owner) return;
    this.path = path; this.owner = owner; this.generation++; this.previous = null;
  }
  cancel(): void { this.path = ""; this.owner = ""; this.generation++; this.previous = null; }
  async poll(now: number, request: (path: string) => Promise<GitContext>, changed: (value: GitContext) => void): Promise<void> {
    if (!this.path || this.inFlight || !Number.isFinite(now)) return;
    const started = this.lastStarted.get(this.path);
    if (started !== undefined && now - started < 5000) return;
    const path = this.path, generation = this.generation;
    this.lastStarted.set(path, now);
    // A single flight is retained even after cancellation, until the original request settles.
    this.inFlight = true;
    let value: GitContext;
    try { const result = await request(path); value = isGitContext(result) ? result : unavailable(null); }
    catch (reason) { value = unavailable(reason); }
    finally { this.inFlight = false; }
    if (generation !== this.generation) return;
    if (JSON.stringify(value) === JSON.stringify(this.previous)) return;
    this.previous = value; changed(value);
  }
}

export type GitChange = {
    path: string;
    staged: string;
    worktree: string;
    untracked: boolean;
    unsupported: boolean;
};

export type GitPatch = {
    path: string;
    side: "staged" | "worktree";
    kind: "text" | "binary" | "unsupported";
    text: string | null;
};

export type GitChanges = {
    query_token: string;
    path: string;
    root: string | null;
    rows: GitChange[];
    patch: GitPatch | null;
};

export type GitChangesState = {
    kind: "loading";
} | {
    kind: "ready";
    value: GitChanges;
} | {
    kind: "unavailable";
    code: string;
};

export type GitChangesRequest = {
    path: string;
    query_token: string;
    selected_path?: string;
    side?: "staged" | "worktree";
};

const queryToken = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const byteSize = (value: string) => new TextEncoder().encode(value).length;

function exactKeys(value: unknown, keys: string[]): value is Record<string, unknown> {
    return !!value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === keys.length && Object.keys(value).every(key => keys.includes(key));
}

function relativePath(value: unknown): value is string {
    return typeof value === "string" && value.length > 0 && byteSize(value) <= 4096 && !/[\x00-\x1f\x7f]/.test(value) && !value.startsWith("/") && !value.split(/[\/\\]/).some(part => part === ".." || part === "");
}

export function isGitChanges(value: unknown): value is GitChanges {
    if (!exactKeys(value, ["query_token", "path", "root", "rows", "patch"]) || typeof value.query_token !== "string" || !queryToken.test(value.query_token)
        || typeof value.path !== "string" || !value.path || byteSize(value.path) > 4096 || (value.root !== null && (typeof value.root !== "string" || !value.root || byteSize(value.root) > 4096))
        || !Array.isArray(value.rows) || value.rows.length > 4096)
        return false;
    let size = byteSize(value.path) + (typeof value.root === "string" ? byteSize(value.root) : 0);
    for (const row of value.rows) {
        if (!exactKeys(row, ["path", "staged", "worktree", "untracked", "unsupported"]) || !relativePath(row.path)
            || typeof row.staged !== "string" || typeof row.worktree !== "string" || !/^[ MADRCUT?!]$/.test(row.staged) || !/^[ MADRCUT?!]$/.test(row.worktree)
            || typeof row.untracked !== "boolean" || typeof row.unsupported !== "boolean")
            return false;
        // Raw field bytes are a lower bound, unlike invented per-row overhead.
        // The complete serialized DTO is checked exactly below.
        size += byteSize(row.path);
        if (size > 1048576)
            return false;
    }
    if (value.patch !== null) {
        const patch = value.patch;
        if (!exactKeys(patch, ["path", "side", "kind", "text"]) || !relativePath(patch.path) || !["staged", "worktree"].includes(String(patch.side))
            || !["text", "binary", "unsupported"].includes(String(patch.kind)) || (patch.kind === "text" ? typeof patch.text !== "string" || byteSize(patch.text) > 262144 : patch.text !== null)
            || !value.rows.some(row => row.path === patch.path))
            return false;
        size += typeof patch.text === "string" ? byteSize(patch.text) : 0;
    }
    return size <= 1048576 && byteSize(JSON.stringify(value)) <= 1048576;
}

type ChangesLoad = {
    request: (args: GitChangesRequest) => Promise<unknown>;
    cancel: (token: string) => Promise<unknown>;
    changed: (state: GitChangesState) => void;
    selection?: {
        path: string;
        side: "staged" | "worktree";
    };
    root?: string;
    generation: number;
};

export class GitChangesController {
    private path = "";
    private owner = "";
    private generation = 0;
    private active: {
        token: string;
        cancel: (token: string) => Promise<unknown>;
        cancelled: boolean;
    } | null = null;
    private pending: ChangesLoad | null = null;
    private token: () => string;
    constructor(token: () => string = () => crypto.randomUUID()) { this.token = token; }
    select(path: string, owner: string): void {
        if (path === this.path && owner === this.owner)
            return;
        this.invalidate();
        this.path = path;
        this.owner = owner;
    }
    private invalidate(): void {
        this.generation++;
        this.pending = null;
        this.cancelActive();
    }
    private cancelActive(): void {
        if (this.active && !this.active.cancelled) {
            this.active.cancelled = true;
            void this.active.cancel(this.active.token).catch(() => { });
        }
    }
    cancel(): void { this.invalidate(); this.path = ""; this.owner = ""; }
    async load(request: ChangesLoad["request"], cancel: ChangesLoad["cancel"], changed: ChangesLoad["changed"], selection?: ChangesLoad["selection"], root?: string): Promise<void> {
        const load = { request, cancel, changed, selection, root, generation: this.generation };
        if (!this.path)
            return;
        if (this.active) {
            this.generation++;
            load.generation = this.generation;
            this.pending = load;
            this.cancelActive();
            return;
        }
        await this.run(load);
    }
    private async run(load: ChangesLoad): Promise<void> {
        if (load.generation !== this.generation || !this.path)
            return;
        const args: GitChangesRequest = { path: this.path, query_token: this.token() };
        if (load.selection) {
            args.selected_path = load.selection.path;
            args.side = load.selection.side;
        }
        const active = { token: args.query_token, cancel: load.cancel, cancelled: false };
        this.active = active;
        load.changed({ kind: "loading" });
        try {
            const value = await load.request(args);
            if (load.generation !== this.generation)
                return;
            if (!isGitChanges(value) || value.query_token !== args.query_token || value.path !== args.path || (load.root !== undefined && load.root !== value.root)
                || (load.selection ? value.patch?.path !== load.selection.path || value.patch?.side !== load.selection.side : value.patch !== null)) {
                load.changed({ kind: "unavailable", code: "git_context_changed" });
                return;
            }
            load.changed({ kind: "ready", value });
        }
        catch (reason) {
            if (load.generation === this.generation) {
                const codes = new Set([...errorCodes, "git_cancelled", "git_cancel_capacity", "git_invalid_request"]);
                load.changed({ kind: "unavailable", code: typeof reason === "string" && codes.has(reason) ? reason : "git_query_failed" });
            }
        }
        finally {
            if (this.active === active)
                this.active = null;
            const pending = this.pending;
            this.pending = null;
            if (pending && pending.generation === this.generation)
                await this.run(pending);
        }
    }
}
