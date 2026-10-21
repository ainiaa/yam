import {t} from "./i18n";
import {Select} from "./Select";
// Author: Jeff.Liu. Read-only Git operations; file contents require a separate action.
import {useCallback, useEffect, useMemo, useRef, useState} from "react";
import {invoke} from "@tauri-apps/api/core";
import {GitChangesController, type GitChangesRequest, type GitChangesState, type GitPatch} from "./git-context";
import {parseUnifiedDiff, findDiffLine} from "./git-diff-navigation";
import {FilePreview} from "./FilePreview";
import type {PreviewTarget} from "./file-preview";

export function GitPatchView({patch}: {patch: GitPatch}) {
  const document = useMemo(() => parseUnifiedDiff(patch.text ?? ""), [patch.text]);
  const root = useRef<HTMLDivElement | null>(null);
  const [hunk, setHunk] = useState(0);
  const [line, setLine] = useState("");
  const [side, setSide] = useState<"old" | "new">("new");
  const [notice, setNotice] = useState("");
  function focusRow(index: number) {
    if (!document || index < 0 || index >= document.rows.length) return;
    setHunk(document.rows[index].hunk ?? 0);
    const row = root.current?.querySelector<HTMLElement>(`[data-diff-row="${index}"]`);
    row?.focus({preventScroll: true});
    row?.scrollIntoView({block: "nearest", inline: "nearest"});
    setNotice("");
  }
  function move(delta: number) {
    if (document?.hunks.length) focusRow(document.hunks[Math.max(0, Math.min(document.hunks.length - 1, hunk + delta))].row);
  }
  function jump() {
    if (!document) return;
    const index = /^\d+$/.test(line) ? findDiffLine(document, side, Number(line)) : -1;
    if (index < 0) setNotice("Line is not included in this diff.");
    else focusRow(index);
  }
  return <div className="git-patch-view" ref={root}>
    <p>{patch.side === "staged" ? t("Staged changes · old: HEAD · new: index.") : t("Working tree changes · old: index · new: working tree.")} {t("Line numbers refer to these diff sides.")}</p>
    {!document ? <><p role="status">{t("Line navigation unavailable for this patch. Showing literal diff text.")}</p><pre>{patch.text}</pre></> : <>
      {document.hunks.length === 0 ? <p>{t("No change blocks in this patch.")}</p> : <>
        <div className="git-diff-navigation">
          <button type="button" disabled={hunk === 0} onClick={() => move(-1)}>{t("Previous change")}</button>
          <span aria-live="polite">{t("Change")+" "}{hunk + 1} {t("of")+" "}{document.hunks.length}</span>
          <button type="button" disabled={hunk >= document.hunks.length - 1} onClick={() => move(1)}>{t("Next change")}</button>
          <label>{t("Side")+" "}<Select aria-label={t("Diff line side")} value={side} onChange={event => setSide(event.target.value as "old" | "new")}><option value="old">{t("Old")}</option><option value="new">{t("New")}</option></Select></label>
          <label>{t("Line")+" "}<input aria-label={t("Diff line number")} type="number" min="1" step="1" value={line} onChange={event => setLine(event.target.value)} onKeyDown={event => { if (event.key === "Enter") { event.preventDefault(); jump(); } }}/></label>
          <button type="button" onClick={jump}>{t("Go to line")}</button>
        </div>
        {notice && <p role="status">{t(notice)}</p>}
      </>}
      <div className="git-diff-lines" role="region" aria-label={t("Diff old and new line numbers")} tabIndex={0}>
        <div className="git-diff-line git-diff-column-labels"><span>{t("Old")}</span><span>{t("New")}</span><span>{t("Diff")}</span></div>
        {document.rows.map((row, index) => <div key={index} data-diff-row={index} data-kind={row.kind} data-active={row.kind === "hunk" && row.hunk === hunk} className="git-diff-line" tabIndex={-1}>
          <span className="git-diff-number">{row.oldLine ?? ""}</span><span className="git-diff-number">{row.newLine ?? ""}</span><code>{row.text || " "}</code>
        </div>)}
      </div>
    </>}
  </div>;
}

export function GitChanges({path, owner, sessionId = null}: {path: string; owner: number; sessionId?:string|null}) {
  const [open, setOpen] = useState(false);
  const previewScope=JSON.stringify([path,owner,sessionId,open]);
  const [preview,setPreview]=useState<{scope:string;id:number;target?:PreviewTarget}|null>(null);
  const previewSequence=useRef(0);
  useEffect(()=>{setPreview(null);},[previewScope]);
  const [snapshot, setState] = useState<(GitChangesState & {path: string; owner: number}) | null>(null);
  // Hide stale data during render, before passive effects can cancel the old query.
  const state = open && snapshot?.path === path && snapshot.owner === owner ? snapshot : null;
  const controller = useRef(new GitChangesController());
  const context = useRef({path, owner, open,sessionId});
  context.current = {path, owner, open,sessionId};
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
    context.current = {path, owner, open,sessionId};
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
    setPreview(null);
    setOpen(false);
  };
  const value = state?.kind === "ready" ? state.value : null;
  return <section className="git-changes">
    {!open ? <button type="button" onClick={() => setOpen(true)} disabled={!path}>{t("Git changes")}</button> : <>
      <div className="git-changes-heading">
        <h3>{t("Git changes")}</h3><button type="button" onClick={close}>{t("Close Git changes")}</button>
      </div>
      <p>{t("Read only. Untracked files show names only until explicitly previewed. Preview reads the current working tree, including for staged rows.")}</p>
      {state?.kind === "loading" && <p role="status">{t("Reading Git changes…")}</p>}
      {state?.kind === "unavailable" && <div role="alert">
        <p>{t("Git changes unavailable (")}{state.code}).</p>
        <button type="button" onClick={() => load()}>{t("Retry")}</button>
      </div>}
      {value && <>
        <p>{value.root === null ? t("Not a Git repository") : value.rows.length === 0 ? t("No changes") : value.root}</p>
        <ul>{value.rows.map(row => <li key={row.path}>
          <span>{row.path}</span>
          {row.untracked ? <span>{t("Untracked · names only")}</span> : <>
            {row.staged !== " " && <button type="button" aria-label={t("Staged changes for {{value0}}", {value0:row.path})}
              onClick={() => load({path: row.path, side: "staged"}, value.root ?? undefined)}>{t("Staged (")}{row.staged})</button>}
            {row.worktree !== " " && <button type="button" aria-label={t("Worktree changes for {{value0}}", {value0:row.path})}
              onClick={() => load({path: row.path, side: "worktree"}, value.root ?? undefined)}>{t("Worktree (")}{row.worktree})</button>}
          </>}
          <button type="button" aria-label={t("Preview current file {{value0}}", {value0:row.path})} disabled={row.unsupported} onClick={()=>{
            const current=context.current;if(!current.open||current.path!==path||current.owner!==owner||current.sessionId!==sessionId)return;
            setPreview({scope:previewScope,id:++previewSequence.current,target:sessionId&&value.root?{sessionId,path:`${value.root.replace(/\/$/,"")}/${row.path}`}:undefined});
          }}>{t("Preview current file")}</button>
        </li>)}</ul>
        {value.patch && <div className="git-patch">
          <h4>{value.patch.side} · {value.patch.path}</h4>
          {value.patch.kind === "text" ? <GitPatchView key={value.query_token} patch={value.patch}/> : <p>{value.patch.kind === "binary"
            ? t("Binary changes cannot be shown as text.") : t("This change type has no text comparison.")}</p>}
        </div>}
      </>}
    </>}
    <FilePreview scope={previewScope} invoke={invoke} request={preview?.scope===previewScope?preview:undefined}/>
  </section>;
}
