export type ProjectColor="blue"|"green"|"orange"|"purple"|"red"|"gray";
export type ProjectIcon="folder"|"terminal"|"play";
export const PROJECT_COLORS={blue:"#60a5fa",green:"#4ade80",orange:"#fb923c",purple:"#c084fc",red:"#f87171",gray:"#9ca3af"} as const;
export function validProjectColor(value:unknown):value is ProjectColor{return typeof value==="string"&&Object.prototype.hasOwnProperty.call(PROJECT_COLORS,value);}
export function validProjectIcon(value:unknown):value is ProjectIcon{return value==="folder"||value==="terminal"||value==="play";}
export function projectColor(value:unknown){return validProjectColor(value)?PROJECT_COLORS[value]:"currentColor";}
export type Project = { path: string; name: string; pinned?:boolean; hidden?:boolean; hiddenBefore?:number; color?:ProjectColor; icon?:ProjectIcon };

export function projectKey(path: string) {
  return path.trim().replace(/[\\/]+$/, "") || "/";
}

export function projectName(path: string) {
  const parts = projectKey(path).split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] || path;
}

export function groupProjects<T extends { summary: { cwd: string } }>(
  projects: Project[],
  sessions: T[],
) {
  const groups = new Map<string, Project & { sessions: T[] }>();
  const hidden = new Set(projects.filter(project=>project.hidden===true).map(project=>projectKey(project.path)));
  for (const project of [...projects.filter(project=>project.pinned===true),...projects.filter(project=>project.pinned!==true)]) {
    if (project.hidden===true) continue;
    groups.set(projectKey(project.path), { ...project, sessions: [] });
  }
  for (const session of sessions) {
    const key = projectKey(session.summary.cwd);
    const project = projects.find(project=>projectKey(project.path)===key);
    const startedAt=(session as unknown as {started_at?:unknown}).started_at;
    if (hidden.has(key) || (project?.hiddenBefore !== undefined && typeof startedAt === "number" && startedAt <= project.hiddenBefore)) continue;
    if (!groups.has(key))
      groups.set(key, {
        path: session.summary.cwd,
        name: projectName(session.summary.cwd),
        sessions: [],
      });
    groups.get(key)!.sessions.push(session);
  }
  return Array.from(groups.values());
}

export function readPreference<T>(
  key: string,
  fallback: T,
  valid: (value: unknown) => value is T,
): T {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(key) ?? "null");
    return valid(value) ? value : fallback;
  } catch {
    return fallback;
  }
}

export function isProjects(value: unknown): value is Project[] {
  return (
    Array.isArray(value) &&
    value.every(
      (item) =>
        item && typeof item.path === "string" && typeof item.name === "string" && (!Object.prototype.hasOwnProperty.call(item,"pinned")||typeof item.pinned==="boolean")&&(!Object.prototype.hasOwnProperty.call(item,"hidden")||typeof item.hidden==="boolean")&&(!Object.prototype.hasOwnProperty.call(item,"hiddenBefore")||typeof item.hiddenBefore==="number"&&Number.isFinite(item.hiddenBefore))&&(!Object.prototype.hasOwnProperty.call(item,"color")||validProjectColor(item.color))&&(!Object.prototype.hasOwnProperty.call(item,"icon")||validProjectIcon(item.icon)),
    )
  );
}

export function validateSessionTitle(value: string): string {
  const title = value.trim();
  if (!title || [...title].length > 200 || /[\x00-\x1f\x7f]/.test(title)) throw new Error("Use a session name of 1–200 characters.");
  return title;
}
export function matchesStatus(status: string, filter: string): boolean {
  if (filter === "all") return true;
  if (filter === "active") return status === "starting" || status === "running";
  if (filter === "attention") return status === "needs_attention" || status === "failed";
  return status === filter;
}

export async function selectProjectDirectory(pick: () => Promise<string | null>, validate: (path: string) => Promise<unknown>) {
  const path = await pick();
  if (path === null) return null;
  await validate(path);
  return path;
}

// Author: Jeff.Liu. Display name only; project path remains its identity.
export function validateProjectName(value:string):string {
  if(typeof value!=="string")throw new Error("Use a project name of 1–200 characters.");
  const name=value.trim();if(!name||[...name].length>200)throw new Error("Use a project name of 1–200 characters.");return name;
}

// Author: Jeff.Liu. Saved order is the existing project array order.
export function moveProjectAdjacent(projects:Project[],path:string,direction:"up"|"down"):Project[] {
  if(direction!=="up"&&direction!=="down")return projects;
  const matches=projects.map((project,index)=>({project,index})).filter(row=>projectKey(row.project.path)===projectKey(path));
  if(matches.length!==1||matches[0].project.path!==path)return projects;
  const index=matches[0].index,group=projects.map((project,index)=>({project,index})).filter(row=>row.project.hidden!==true&&(row.project.pinned===true)===(projects[index].pinned===true)),position=group.findIndex(row=>row.index===index),adjacent=position+(direction==="up"?-1:1);
  if(adjacent<0||adjacent>=group.length)return projects;
  const neighbor=group[adjacent].index;
  const next=[...projects];[next[index],next[neighbor]]=[next[neighbor],next[index]];return next;
}

// Author: Jeff.Liu. Explicit pin joins the pinned tail; unpin has no historical position memory.
export function setProjectPinned(projects:Project[],path:string,desired:boolean):Project[] {
 if(typeof desired!=="boolean")return projects;
 const matches=projects.filter(project=>projectKey(project.path)===projectKey(path));
 if(matches.length!==1||matches[0].path!==path||(matches[0].pinned===true)===desired)return projects;
 const target=matches[0],changed={...target,pinned:desired};
 const next=desired?[...projects.filter(project=>project!==target),changed]:projects.map(project=>project===target?changed:project);
 return [...next.filter(project=>project.pinned===true),...next.filter(project=>project.pinned!==true)];
}

// Author: Jeff.Liu. Move within existing pin-group slots without recreating project metadata.
export function moveProjectToTarget(projects:Project[],sourcePath:string,targetPath:string):Project[] {
 const source=projects.filter(project=>projectKey(project.path)===projectKey(sourcePath)),target=projects.filter(project=>projectKey(project.path)===projectKey(targetPath));
 if(source.length!==1||target.length!==1||source[0].path!==sourcePath||target[0].path!==targetPath||source[0]===target[0]||(source[0].pinned===true)!==(target[0].pinned===true))return projects;
 const group=projects.filter(project=>(project.pinned===true)===(source[0].pinned===true)),from=group.indexOf(source[0]),to=group.indexOf(target[0]);
 group.splice(from,1);group.splice(to,0,source[0]);
 let index=0;return projects.map(project=>(project.pinned===true)===(source[0].pinned===true)?group[index++]:project);
}

// Keep project order intact; folding is presentation only and never archives history.
export function sidebarSessions<T extends {summary:{session_id:string};status:string;agent?:{unread_count?:number}}>(sessions:readonly T[],selected:string|null,pinned:readonly string[],revealAll=false){
  const current:T[]=[],ended:T[]=[],pins=new Set(pinned);
  for(const record of sessions){
    const id=record.summary.session_id;
    if(revealAll||!["succeeded","stopped"].includes(record.status)||id===selected||pins.has(id)||(record.agent?.unread_count??0)>0)current.push(record);
    else ended.push(record);
  }
  return {current,ended};
}
export function defaultTerminalTitle(sessionId:string,label:string,at?:Date){
  const parts=/^s-([0-9a-f]+)-([0-9a-f]+)$/i.exec(sessionId);
  if(!parts)return label;
  const created=at??new Date(Number.parseInt(parts[1],16));
  const clock=Number.isFinite(created.getTime())?[created.getHours(),created.getMinutes()].map(value=>String(value).padStart(2,"0")).join(":"):null;
  return `${label}${clock?` ${clock}`:""} · ${parts[2]}`;
}
