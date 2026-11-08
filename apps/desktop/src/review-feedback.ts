// Author: Jeff.Liu. Use native CLI input; never send an Enter key or start a process.
import {inspectTerminalPaste} from './terminal-paste.ts';
import {relativeProjectFile,type FilesInvoke} from './project-files.ts';
import {findDiffLine,parseUnifiedDiff,type ReviewPatch} from './git-diff-navigation.ts';
import {isGitChanges} from './git-context.ts';
import {RunChangesController} from './run-changes.ts';
export type ReviewOrigin={sessionId:string;cwd:string;generation:string;nativeSessionId:string};
type ReviewAnchor={root:string;baselineId:string|null;fingerprint:string;context:string;position:string};
export type ReviewLocation={sessionId:string;path:string;line:number|null;side:'old'|'new';basis:'staged'|'worktree'|'round';anchor?:ReviewAnchor};
export type ReviewRecord={summary:{session_id:string;cwd:string;ssh?:unknown;launch?:{adapter:string;mode:string}|null};status:string;agent?:{generation?:string;agent_session_id:string|null;integration:string;phase:string}};
const id=(value:unknown):value is string=>typeof value==='string'&&/^[A-Za-z0-9_.:-]{1,256}$/.test(value);
const validReviewLine = (line: number): boolean => Number.isSafeInteger(line) && line >= 1 && line <= 1048576;
export function reviewOrigin(record?:ReviewRecord|null):ReviewOrigin|null {
 const summary=record?.summary,agent=record?.agent;
 if(!summary||summary.ssh!=null||!['codex','claude','gemini','opencode','pi'].includes(summary.launch?.adapter??'')||summary.launch?.mode!=='interactive'||!id(summary.session_id)||!id(agent?.generation)||!id(agent?.agent_session_id)||typeof summary.cwd!=='string'||!summary.cwd.startsWith('/')||/[\p{Cc}\u202a-\u202e\u2066-\u2069]/u.test(summary.cwd)||summary.cwd.length>4096)return null;
 return{sessionId:summary.session_id,cwd:summary.cwd,generation:agent.generation,nativeSessionId:agent.agent_session_id};
}
export function sameReviewOrigin(a:ReviewOrigin|null,b:ReviewOrigin|null):boolean{return !!a&&!!b&&a.sessionId===b.sessionId&&a.cwd===b.cwd&&a.generation===b.generation&&a.nativeSessionId===b.nativeSessionId;}
export function reviewReady(record:ReviewRecord|null|undefined,origin:ReviewOrigin|null):boolean{return !!record&&sameReviewOrigin(reviewOrigin(record),origin)&&record.status==='running'&&record.agent?.integration==='connected'&&['idle','response_finished'].includes(record.agent.phase);}
export function formatReviewFeedback(origin:ReviewOrigin,location:ReviewLocation,text:string):string {
 if(location.sessionId!==origin.sessionId||relativeProjectFile(origin.cwd,`${origin.cwd.replace(/\/+$/,'')}/${location.path}`)!==location.path||!['old','new'].includes(location.side)||!['staged','worktree','round'].includes(location.basis)||location.line!==null&&!validReviewLine(location.line)||typeof text!=='string')throw 'review_invalid_feedback';
 const body=text.replace(/\r\n?/g,'\n').trim();
 if(!body||new TextEncoder().encode(body).length>16384||/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/.test(body))throw 'review_invalid_feedback';
 const formatted=`Code review feedback (file location is snapshot context):\nPath: ${JSON.stringify(location.path)}\nComparison: ${location.basis}\n${location.side}-side line: ${location.line??'file-level'}\nComment:\n${body}`;
 try{return inspectTerminalPaste(formatted).text;}catch{throw 'review_invalid_feedback';}
}
export async function deliverReviewFeedback(origin:ReviewOrigin,location:ReviewLocation,text:string,current:()=>Promise<ReviewRecord>,paste:(text:string)=>Promise<void>):Promise<void>{
 const formatted=formatReviewFeedback(origin,location,text);let record:ReviewRecord;
 try{record=await current();}catch{throw 'review_target_unavailable';}
 if(!reviewReady(record,origin))throw 'review_target_unavailable';await paste(formatted);
}

export type ReviewComment={location:ReviewLocation;text:string};
export function combineReviewComments(origin:ReviewOrigin,comments:ReviewComment[]):string {
 if(!Array.isArray(comments)||comments.length<1||comments.length>20)throw 'review_invalid_feedback';
 const body=comments.map(item=>formatReviewFeedback(origin,item.location,item.text)).join('\n\n');
 // Validate the aggregate through the same bounded terminal-input path as a single comment.
 formatReviewFeedback(origin,comments[0].location,body);return body;
}

export type ReviewLocationStatus = 'current' | 'stale' | 'unavailable';
const encoder = new TextEncoder();
const safeRoot = (value: unknown): value is string =>
  typeof value === 'string' && value.startsWith('/') && value.length <= 4096 && !/[\p{Cc}\u202a-\u202e\u2066-\u2069]/u.test(value);

async function reviewFingerprint(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(text));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}
const reviewContext = (text: string): string => text.replace(/[\p{Cc}\u202a-\u202e\u2066-\u2069]/gu, '�').slice(0, 512);
const reviewPosition = (location: ReviewLocation): string =>
  JSON.stringify([location.path,location.basis,location.side,location.line]);

export async function createReviewAnchor(location: ReviewLocation, patch: ReviewPatch): Promise<ReviewAnchor> {
  if (location.line === null || !validReviewLine(location.line)) throw 'review_location_unavailable';
  const document = parseUnifiedDiff(patch.text);
  const index = document ? findDiffLine(document, location.side, location.line) : -1;
  if (!document || index < 0) throw 'review_location_unavailable';
  const context = reviewContext(document.rows[index].text);
  return {root: patch.root, baselineId: patch.baselineId, fingerprint: await reviewFingerprint(patch.text), context, position: reviewPosition(location)};
}

type ReviewPatchResult = {status: 'current'; text: string; fingerprint: string} | {status: 'stale' | 'unavailable'};
async function readReviewPatch(origin: ReviewOrigin, location: ReviewLocation, anchor: ReviewAnchor, invoke: FilesInvoke): Promise<ReviewPatchResult> {
  const absolutePath = `${origin.cwd.replace(/\/$/, '')}/${location.path}`;
  const path = relativeProjectFile(anchor.root, absolutePath);
  if (!path) return {status: 'stale'};
  try {
    let text: string;
    if (location.basis === 'round') {
      const controller = new RunChangesController();
      controller.select(origin.sessionId, origin.cwd);
      await controller.load(invoke);
      if (controller.error) return {status: 'unavailable'};
      if (controller.baseline?.id !== anchor.baselineId || controller.baseline?.root !== anchor.root) return {status: 'stale'};
      await controller.compare(invoke, path);
      if (controller.error === 'round_baseline_changed' || controller.error === 'round_comparison_unavailable') return {status: 'stale'};
      if (!controller.report?.patch) return {status: 'unavailable'};
      text = controller.report.patch.text;
    } else {
      const token = crypto.randomUUID();
      const reply = await invoke('get_git_changes', {path: origin.cwd, query_token: token, selected_path: path, side: location.basis});
      if (!isGitChanges(reply) || reply.query_token !== token || reply.path !== origin.cwd || reply.comparison) return {status: 'unavailable'};
      if (reply.root !== anchor.root || reply.patch?.path !== path || reply.patch.side !== location.basis || reply.patch.kind !== 'text' || reply.patch.text === null) return {status: 'stale'};
      text = reply.patch.text;
    }
    return {status: 'current', text, fingerprint: await reviewFingerprint(text)};
  } catch (reason) {
    return {status: reason === 'git_context_changed' ? 'stale' : 'unavailable'};
  }
}

export async function checkReviewLocations(origin: ReviewOrigin, locations: ReviewLocation[], invoke: FilesInvoke, stillCurrent = () => true): Promise<ReviewLocationStatus[]> {
  const results = locations.map(():ReviewLocationStatus => 'unavailable');
  const groups = new Map<string, {index:number; location:ReviewLocation; anchor:ReviewAnchor}[]>();
  if (!stillCurrent()) return results;
  locations.forEach((location,index) => {
    if (location.sessionId !== origin.sessionId) return;
    if (location.line === null) {results[index] = 'current'; return;}
    const anchor = location.anchor;
    if (!anchor || !validReviewLine(location.line) || anchor.position !== reviewPosition(location)) {results[index] = 'stale'; return;}
    const key = JSON.stringify([location.path, location.basis, anchor.root, anchor.baselineId]);
    const group = groups.get(key) ?? [];
    group.push({index,location,anchor});
    groups.set(key,group);
  });
  for (const group of groups.values()) {
    if (!stillCurrent()) break;
    const first = group[0];
    const result = await readReviewPatch(origin, first.location, first.anchor, invoke);
    if (!stillCurrent()) break;
    const document = result.status === 'current' ? parseUnifiedDiff(result.text) : null;
    for (const {index,location,anchor} of group) {
      if (result.status !== 'current') {results[index] = result.status; continue;}
      const row = document && location.line !== null ? findDiffLine(document,location.side,location.line) : -1;
      results[index] = document && row >= 0 && result.fingerprint === anchor.fingerprint &&
        reviewContext(document.rows[row].text) === anchor.context ? 'current' : 'stale';
    }
  }
  return results;
}

export const REVIEW_DRAFT_KEY = 'yam.reviewFeedback.v1';
export type ReviewDraft = {origin: ReviewOrigin | null; location: ReviewLocation | null; text: string; comments: ReviewComment[]};
export type ReviewStorage = Pick<Storage, 'getItem' | 'setItem'>;
export type ReviewStorageProblem = 'corrupt' | 'unavailable' | null;
export function emptyReviewDraft(): ReviewDraft {
  return {origin: null, location: null, text: '', comments: []};
}

function validSavedLocation(origin: ReviewOrigin, location: ReviewLocation): boolean {
  formatReviewFeedback(origin, location, 'validation');
  if (location.line === null) return location.anchor === undefined;
  const anchor = location.anchor;
  return !!anchor && safeRoot(anchor.root) && /^[a-f0-9]{64}$/.test(anchor.fingerprint)
    && typeof anchor.context === 'string' && anchor.context.length > 0 && anchor.context.length <= 512
    && typeof anchor.position === 'string' && anchor.position.length > 0 && anchor.position.length <= 8192
    && (location.basis === 'round' ? typeof anchor.baselineId === 'string' && /^[a-zA-Z0-9-]{1,128}$/.test(anchor.baselineId) : anchor.baselineId === null);
}

function validateReviewDraft(draft: ReviewDraft): void {
  const {origin, location, text, comments} = draft;
  if (typeof text !== 'string' || text.length > 16384 || !Array.isArray(comments) || comments.length > 20) throw 'review_storage_invalid';
  if (origin === null) {
    if (location !== null || comments.length) throw 'review_storage_invalid';
  } else {
    if (!id(origin.sessionId) || !id(origin.generation) || !id(origin.nativeSessionId) || !safeRoot(origin.cwd)
      || (location !== null && !validSavedLocation(origin, location))) throw 'review_storage_invalid';
    for (const comment of comments) {
      if (!validSavedLocation(origin, comment.location)) throw 'review_storage_invalid';
      formatReviewFeedback(origin, comment.location, comment.text);
    }
  }
}

export function loadReviewDraft(storage?: ReviewStorage): {draft: ReviewDraft; problem: ReviewStorageProblem} {
  let raw: string | null;
  try { raw = (storage ?? globalThis.localStorage).getItem(REVIEW_DRAFT_KEY); }
  catch { return {draft: emptyReviewDraft(), problem: 'unavailable'}; }
  if (raw === null) return {draft: emptyReviewDraft(), problem: null};
  try {
    if (raw.length > 131072 || encoder.encode(raw).length > 131072) throw 'review_storage_limit';
    const draft: ReviewDraft = JSON.parse(raw);
    validateReviewDraft(draft);
    return {draft, problem: null};
  } catch { return {draft: emptyReviewDraft(), problem: 'corrupt'}; }
}

export function saveReviewDraft(draft: ReviewDraft, storage?: ReviewStorage): void {
  validateReviewDraft(draft);
  const raw = JSON.stringify(draft);
  if (encoder.encode(raw).length > 131072) throw 'review_storage_limit';
  (storage ?? globalThis.localStorage).setItem(REVIEW_DRAFT_KEY, raw);
}
