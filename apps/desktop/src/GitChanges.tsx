// Author: Jeff.Liu. Fixed, read-only Git operations; no untracked file contents.
import {useCallback, useEffect, useRef, useState} from "react";
import {invoke} from "@tauri-apps/api/core";
import {GitChangesController, type GitChangesRequest, type GitChangesState} from "./git-context";

export function GitChanges({path, owner}: {path: string; owner: number}) {
  const [open, setOpen] = useState(false);
  const [snapshot, setState] = useState<(GitChangesState & {path: string; owner: number}) | null>(null);
  // Hide stale data during render, before passive effects can cancel the old query.
  const state = open && snapshot?.path === path && snapshot.owner === owner ? snapshot : null;
  const controller = useRef(new GitChangesController());
  const context = useRef({path, owner, open});
  context.current = {path, owner, open};
  const load = useCallback((selection?: {path: string; side: "staged" | "worktree"}, root?: string) => {
    const directory = path, currentOwner = owner;
    void controller.current.load(
      (args: GitChangesRequest) => invoke("get_git_changes", args),
      token => invoke("cancel_git_changes", {query_token: token}),
      next => {
        const current = context.current;
        if (current.open && current.path === directory && current.owner === currentOwner) setState({...next, path: directory, owner: currentOwner});
      },
      selection,
      root,
    );
  }, [path, owner]);
  useEffect(() => {
    context.current = {path, owner, open};
    controller.current.select(path, String(owner));
    setState(null);
    if (open) load();
    return () => {
      context.current.open = false;
      controller.current.cancel();
    };
  }, [open, path, owner, load]);
  const close = () => {
    context.current.open = false;
    controller.current.cancel();
    setState(null);
    setOpen(false);
  };
  const value = state?.kind === "ready" ? state.value : null;
  return <section className="git-changes">
    {!open ? <button type="button" onClick={() => setOpen(true)} disabled={!path}>Git changes</button> : <>
      <div className="git-changes-heading">
        <h3>Git changes</h3><button type="button" onClick={close}>Close Git changes</button>
      </div>
      <p>Read only. Untracked files show names only.</p>
      {state?.kind === "loading" && <p role="status">Reading Git changes…</p>}
      {state?.kind === "unavailable" && <div role="alert">
        <p>Git changes unavailable ({state.code}).</p>
        <button type="button" onClick={() => load()}>Retry</button>
      </div>}
      {value && <>
        <p>{value.root === null ? "Not a Git repository" : value.rows.length === 0 ? "No changes" : value.root}</p>
        <ul>{value.rows.map(row => <li key={row.path}>
          <span>{row.path}</span>
          {row.untracked ? <span>Untracked · names only</span> : <>
            {row.staged !== " " && <button type="button" aria-label={`Staged changes for ${row.path}`}
              onClick={() => load({path: row.path, side: "staged"}, value.root ?? undefined)}>Staged ({row.staged})</button>}
            {row.worktree !== " " && <button type="button" aria-label={`Worktree changes for ${row.path}`}
              onClick={() => load({path: row.path, side: "worktree"}, value.root ?? undefined)}>Worktree ({row.worktree})</button>}
          </>}
        </li>)}</ul>
        {value.patch && <div className="git-patch">
          <h4>{value.patch.side} · {value.patch.path}</h4>
          {value.patch.kind === "text" ? <pre>{value.patch.text}</pre> : <p>{value.patch.kind === "binary"
            ? "Binary changes cannot be shown as text." : "This change type has no text comparison."}</p>}
        </div>}
      </>}
    </>}
  </section>;
}
