export type MemorySample = {
  application_bytes: number;
  workload_bytes: number;
  metric: "physical footprint" | "RSS" | "working set";
  sampled_at: number;
};

export function memoryLabel(value: MemorySample | null, now = Date.now()): string {
  if (!value || !["physical footprint", "RSS", "working set"].includes(value.metric) ||
      ![value.application_bytes, value.workload_bytes, value.sampled_at].every(n => Number.isSafeInteger(n) && n >= 0) ||
      now < value.sampled_at || now - value.sampled_at > 10_000) return "Memory unavailable";
  const mib = (n: number) => `${(n / 1048576).toFixed(1)} MiB`;
  return `YAM ${mib(value.application_bytes)}${value.workload_bytes ? ` · Tasks ${mib(value.workload_bytes)}` : ""}`;
}

export function startMemoryPolling(
  read: () => Promise<MemorySample>,
  publish: (sample: MemorySample | null) => void,
  visible: () => boolean,
  clock = {now: Date.now, setInterval: globalThis.setInterval, clearInterval: globalThis.clearInterval,
    setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout},
): () => void {
  let disposed = false, pending = false, sample: MemorySample | null = null;
  let expiry: ReturnType<typeof globalThis.setTimeout> | undefined;
  const tick = () => {
    if (disposed) return;
    if (!visible() || memoryLabel(sample, clock.now()) === "Memory unavailable") publish(null);
    if (pending || !visible()) return;
    pending = true;
    void read().then(value => {
      if (disposed) return;
      if (expiry !== undefined) clock.clearTimeout(expiry);
      sample = memoryLabel(value, clock.now()) === "Memory unavailable" ? null : value;
      if (visible()) publish(sample);
      if (sample) expiry = clock.setTimeout(() => {
        sample = null;
        if (!disposed) publish(null);
      }, Math.max(1, sample.sampled_at + 10_001 - clock.now()));
    }).catch(() => {
      sample = null;
      if (expiry !== undefined) clock.clearTimeout(expiry);
      if (!disposed) publish(null);
    }).finally(() => {pending = false;});
  };
  tick();
  const timer = clock.setInterval(tick, 5000);
  return () => {disposed = true; clock.clearInterval(timer); if (expiry !== undefined) clock.clearTimeout(expiry);};
}
