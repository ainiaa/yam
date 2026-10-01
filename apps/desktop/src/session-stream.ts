export type OutputChunk = {
  session_id: string;
  data: string;
  offset: number;
  end_offset: number;
};
export type LogSnapshot = { data: string; offset: number; end_offset: number; status?: string };
const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function consumeOutput(cursor: number, chunk: LogSnapshot) {
  const bytes = encoder.encode(chunk.data);
  if (!Number.isSafeInteger(cursor) || cursor < 0 ||
      !Number.isSafeInteger(chunk.offset) || chunk.offset < 0 ||
      !Number.isSafeInteger(chunk.end_offset) || chunk.end_offset - chunk.offset !== bytes.length)
    throw new Error("Invalid terminal output offsets");
  if (chunk.end_offset <= cursor) return { data: "", nextOffset: cursor };
  if (chunk.offset > cursor) throw new Error("Terminal output gap; reload the log snapshot");
  return { data: decoder.decode(bytes.subarray(cursor - chunk.offset)), nextOffset: chunk.end_offset };
}

export function replayOutput(snapshot: LogSnapshot, chunks: OutputChunk[]) {
  const initial = consumeOutput(snapshot.offset, snapshot);
  let data = initial.data;
  let cursor = initial.nextOffset;
  for (const chunk of [...chunks].sort((a, b) => a.offset - b.offset)) {
    const next = consumeOutput(cursor, chunk);
    data += next.data;
    cursor = next.nextOffset;
  }
  return { data, nextOffset: cursor };
}

export class OutputBuffer {
  private buffers = new Map<string, { chunks: OutputChunk[]; bytes: number }>();
  private maxBytes: number;
  private maxSessions: number;
  constructor(maxBytes = 256 * 1024, maxSessions = 32) {
    if (!Number.isSafeInteger(maxBytes) || !Number.isSafeInteger(maxSessions) || maxBytes < 1 || maxSessions < 1) throw new Error("Output cache limits must be positive");
    this.maxBytes = maxBytes;
    this.maxSessions = maxSessions;
  }
  get size() { return this.buffers.size; }
  byteLength(id: string) { return this.buffers.get(id)?.bytes ?? 0; }
  push(chunk: OutputChunk) {
    consumeOutput(chunk.offset, chunk);
    let bytes = encoder.encode(chunk.data);
    if (bytes.length > this.maxBytes) {
      let start = bytes.length - this.maxBytes;
      while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) start++;
      bytes = bytes.subarray(start);
      chunk = { ...chunk, data: decoder.decode(bytes), offset: chunk.offset + start };
    }
    const entry = this.buffers.get(chunk.session_id) ?? { chunks: [], bytes: 0 };
    entry.chunks.push(chunk);
    entry.bytes += bytes.length;
    while (entry.bytes > this.maxBytes) {
      entry.bytes -= encoder.encode(entry.chunks.shift()!.data).length;
    }
    this.buffers.delete(chunk.session_id);
    this.buffers.set(chunk.session_id, entry);
    while (this.buffers.size > this.maxSessions)
      this.buffers.delete(this.buffers.keys().next().value!);
  }
  drain(id: string) {
    const chunks = this.buffers.get(id)?.chunks ?? [];
    this.buffers.delete(id);
    return chunks;
  }
  delete(id: string) { this.buffers.delete(id); }
  clear() { this.buffers.clear(); }
}
