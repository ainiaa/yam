export type Project = { path: string; name: string };

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
  for (const project of projects) {
    groups.set(projectKey(project.path), { ...project, sessions: [] });
  }
  for (const session of sessions) {
    const key = projectKey(session.summary.cwd);
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
        item && typeof item.path === "string" && typeof item.name === "string",
    )
  );
}
