// Author: Jeff.Liu. Line locations describe the two diff sides, never a live file.
export type DiffRow = {kind: "metadata" | "hunk" | "context" | "add" | "remove" | "marker"; text: string; oldLine: number | null; newLine: number | null; hunk: number | null};
export type DiffHunk = {row: number; oldStart: number; newStart: number; oldCount: number; newCount: number};
export type DiffDocument = {rows: DiffRow[]; hunks: DiffHunk[]};
export function parseUnifiedDiff(text: string): DiffDocument | null {
  if (new TextEncoder().encode(text).length > 262144) return null;
  const lines = text === "" ? [] : text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  // shortcut: very dense patches retain plain text; add virtualization if line navigation above 20000 rows is needed.
  if (lines.length > 20000) return null;
  const document: DiffDocument = {rows: [], hunks: []};
  let active: number | null = null, oldLine = 0, newLine = 0, oldLeft = 0, newLeft = 0, content = false;
  let oldEnd = 0, newEnd = 0;
  let files = 0;
  for (const text of lines) {
    if (text.startsWith("diff --git ") && ++files > 1) return null;
    const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?:.*)$/.exec(text);
    if (header) {
      if (oldLeft !== 0 || newLeft !== 0) return null;
      const [oldStart, oldCount, newStart, newCount] = [Number(header[1]), Number(header[2] ?? 1), Number(header[3]), Number(header[4] ?? 1)];
      if (![oldStart, oldCount, newStart, newCount, oldStart + oldCount, newStart + newCount].every(Number.isSafeInteger) || oldCount > 0 && oldStart < 1 || newCount > 0 && newStart < 1) return null;
      const oldPosition = oldStart + (oldCount === 0 ? 1 : 0), newPosition = newStart + (newCount === 0 ? 1 : 0);
      if (!Number.isSafeInteger(oldPosition) || !Number.isSafeInteger(newPosition) || oldPosition < oldEnd || newPosition < newEnd) return null;
      oldEnd = oldPosition + oldCount; newEnd = newPosition + newCount;
      active = document.hunks.length;
      document.hunks.push({row: document.rows.length, oldStart, newStart, oldCount, newCount});
      oldLine = oldStart; newLine = newStart; oldLeft = oldCount; newLeft = newCount; content = false;
      document.rows.push({kind: "hunk", text, oldLine: null, newLine: null, hunk: active});
    } else {
      if (text.startsWith("@@")) return null;
      if (active === null) {
        document.rows.push({kind: "metadata", text, oldLine: null, newLine: null, hunk: null});
      } else if (text === "\\ No newline at end of file") {
        if (!content) return null;
        document.rows.push({kind: "marker", text, oldLine: null, newLine: null, hunk: active});
        content = false;
      } else {
        const prefix = text[0], usesOld = prefix === " " || prefix === "-", usesNew = prefix === " " || prefix === "+";
        if (!usesOld && !usesNew || usesOld && oldLeft <= 0 || usesNew && newLeft <= 0) return null;
        document.rows.push({kind: prefix === " " ? "context" : prefix === "+" ? "add" : "remove", text, oldLine: usesOld ? oldLine++ : null, newLine: usesNew ? newLine++ : null, hunk: active});
        if (usesOld) oldLeft--;
        if (usesNew) newLeft--;
        content = true;
      }
    }
  }
  return oldLeft === 0 && newLeft === 0 ? document : null;
}

export function findDiffLine(document: DiffDocument, side: "old" | "new", line: number): number {
  return Number.isSafeInteger(line) && line > 0 ? document.rows.findIndex(row => (side === "old" ? row.oldLine : row.newLine) === line) : -1;
}
