// Author: Jeff.Liu. Request state contains no resolved credentials.
export type GatewayIdentity = {query_token: string; status: string; http_status: number | null; version: string | null};
export type GatewayState = {kind: "idle"} | {kind: "checking"} | {kind: "ready"; value: GatewayIdentity; checkedAt: number};
export type GatewayInvoke = (name: string, args: Record<string, unknown>) => Promise<unknown>;
export type CatalogModel = {id: string; display_name: string | null; owned_by: string | null};
export function filterCatalogModels(models: CatalogModel[], query: string): CatalogModel[] {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  return models.filter(model => {
    const text = `${model.display_name ?? ""} ${model.id} ${model.owned_by ?? ""}`.toLowerCase();
    return words.every(word => text.includes(word));
  });
}
export type ModelCatalog = {query_token: string; status: string; http_status: number | null; models: CatalogModel[]};
export type CatalogState = {kind: "idle"} | {kind: "checking"} | {kind: "ready"; value: ModelCatalog; checkedAt: number};
export function isModelCatalog(value: unknown, token: string): value is ModelCatalog {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const reply = value as ModelCatalog;
  if (Object.keys(reply).sort().join(",") !== "http_status,models,query_token,status" || reply.query_token !== token || !(reply.status === "loaded" || reply.status === "pagination_unsupported" || statuses.has(reply.status) && reply.status !== "identified")) return false;
  if (reply.http_status !== null && (!Number.isInteger(reply.http_status) || reply.http_status < 100 || reply.http_status > 599)) return false;
  if (!Array.isArray(reply.models) || reply.models.length > 1000) return false;
  if (reply.status !== "loaded") return reply.models.length === 0;
  if (reply.http_status === null || reply.http_status < 200 || reply.http_status >= 300) return false;
  const seen = new Set<string>();
  return reply.models.every(model => {
    if (!model || typeof model !== "object" || Object.keys(model).sort().join(",") !== "display_name,id,owned_by") return false;
    if (typeof model.id !== "string" || !model.id || new TextEncoder().encode(model.id).length > 256 || /[\s\p{Cc}]/u.test(model.id) || seen.has(model.id)) return false;
    seen.add(model.id);
    return [model.display_name, model.owned_by].every(label => label === null || typeof label === "string" && new TextEncoder().encode(label).length <= 256 && !/\p{Cc}/u.test(label));
  });
}

export function gatewayOrigin(endpoint: string): string | null {
  if (new TextEncoder().encode(endpoint).length > 2048 || /[\s\\?#]/.test(endpoint)) return null;
  // Check literal authority and path before URL normalization can hide aliases.
  if (!/^https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::[0-9]+)?(?:\/(?:v1\/?)?)?$/.test(endpoint)) return null;
  try {
    const url = new URL(endpoint);
    return url.port === "0" ? null : url.origin;
  } catch { return null; }
}

const statuses = new Set(["identified", "unrecognized", "authentication_refused", "redirect_refused", "http_error", "invalid_response", "unsupported", "transport_unavailable", "unreachable", "timed_out", "cancelled", "response_too_large", "credential_unavailable", "tls_error", "unavailable", "busy"]);
export function isGatewayIdentity(value: unknown, token: string): value is GatewayIdentity {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const reply = value as GatewayIdentity;
  if (Object.keys(reply).sort().join(",") !== "http_status,query_token,status,version" || reply.query_token !== token || !statuses.has(reply.status)) return false;
  if (reply.http_status !== null && (!Number.isInteger(reply.http_status) || reply.http_status < 100 || reply.http_status > 599)) return false;
  return reply.status === "identified"
    ? reply.http_status !== null && reply.http_status >= 200 && reply.http_status < 300 && typeof reply.version === "string" && /^[A-Za-z0-9.+_-]{1,128}$/.test(reply.version)
    : reply.version === null;
}

export class ProviderGatewayController {
  snapshot: GatewayState = {kind: "idle"};
  catalog: CatalogState = {kind: "idle"};
  load(invoke: GatewayInvoke, changed: () => void): Promise<void> { return this.query("models", invoke, changed); }
  busy = false;
  scope = "";
  private endpoint = "";
  private key: string | null = null;
  private epoch = 0;
  private active: {token: string; invoke: GatewayInvoke} | null = null;
  private token: () => string;
  constructor(token: () => string = () => crypto.randomUUID()) { this.token = token; }
  select(endpoint: string, key: string | null): void {
    const scope = JSON.stringify([endpoint, key]);
    if (this.scope === scope) return;
    this.cancel();
    this.scope = scope;
    this.endpoint = endpoint;
    this.key = key;
  }
  cancel(): void {
    this.epoch++;
    this.snapshot = {kind: "idle"};
    this.catalog = {kind: "idle"};
    if (this.active) void this.active.invoke("cancel_provider_gateway", {queryToken: this.active.token}).catch(() => {});
  }
  check(invoke: GatewayInvoke, changed: () => void): Promise<void> { return this.query("identity", invoke, changed); }
  private async query(kind: "identity" | "models", invoke: GatewayInvoke, changed: () => void): Promise<void> {
    if (this.busy) return;
    const token = this.token(), epoch = this.epoch;
    const publish = (value: unknown, status: string) => {
      if (epoch !== this.epoch) return;
      if (kind === "identity") this.snapshot = {kind: "ready", value: isGatewayIdentity(value, token) ? value : {query_token: token, status, http_status: null, version: null}, checkedAt: Date.now()};
      else this.catalog = {kind: "ready", value: isModelCatalog(value, token) ? value : {query_token: token, status, http_status: null, models: []}, checkedAt: Date.now()};
    };
    if (!gatewayOrigin(this.endpoint)) {
      publish(null, "unsupported");
      changed();
      return;
    }
    const active = {token, invoke};
    this.active = active;
    this.busy = true;
    if (kind === "identity") this.snapshot = {kind: "checking"};
    else this.catalog = {kind: "checking"};
    changed();
    try {
      const value = await invoke(kind === "identity" ? "check_provider_gateway" : "load_provider_models", {endpoint: this.endpoint, apiKeyEnv: this.key, queryToken: token});
      publish(value, "invalid_response");
    } catch {
      publish(null, "unavailable");
    } finally {
      if (this.active === active) { this.active = null; this.busy = false; }
      changed();
    }
  }
}
