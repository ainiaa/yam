import {i18n} from "./i18n";
import {t} from "./i18n";
// Author: Jeff.Liu. Explicit gateway checks leave manual provider settings intact.
import {useEffect, useRef, useState, type ReactNode} from "react";
import {EditableCombo} from "./EditableCombo";
import {ProviderGatewayController, gatewayOrigin, type GatewayInvoke} from "./provider-catalog";

const messages: Record<string, string> = {
  unrecognized: "The local API did not identify itself as Magpie.",
  authentication_refused: "The gateway refused this request. Check the selected key environment variable.",
  redirect_refused: "The gateway returned a redirect. Check its API address.",
  http_error: "The gateway returned an HTTP error.",
  invalid_response: "The gateway returned an unsupported response.",
  unsupported: "Gateway API checks support only localhost, 127.0.0.1 or ::1 with an empty path or /v1.",
  transport_unavailable: "Gateway API checks are unavailable on this system. Enter the model manually.",
  unreachable: "Cannot connect to this local gateway.",
  timed_out: "The gateway check timed out (3 seconds maximum).",
  cancelled: "The gateway check was cancelled.",
  response_too_large: "The gateway response exceeded the size limit.",
  credential_unavailable: "The selected key environment variable is missing or invalid in this YAM process.",
  tls_error: "The gateway TLS certificate could not be verified.",
  unavailable: "Gateway API check unavailable. Try again manually.",
  busy: "A gateway check is still finishing. Try again shortly.",
  pagination_unsupported: "This gateway returned a partial catalog. Enter the model manually; this catalog format is not supported.",
};

export function ProviderCatalog({endpoint, model, apiKeyEnv, invoke, onSelect, children, identityCheck = true}: {endpoint: string; model: string; apiKeyEnv: string | null; invoke: GatewayInvoke; onSelect: (id: string) => void; children?: ReactNode; identityCheck?: boolean}) {
  const controller = useRef(new ProviderGatewayController());
  const element = useRef<HTMLDivElement | null>(null);
  const mounted = useRef(false);
  const [, redraw] = useState(0);
  const scope = JSON.stringify([endpoint, apiKeyEnv]);
  const selectionScope = useRef(scope);
  selectionScope.current = scope;
  const changed = () => { if (mounted.current) redraw(value => value + 1); };
  const current = controller.current;
  // Hide the previous selection during render, before the effect cancels it.
  const state = current.scope === scope ? current.snapshot : {kind: "idle" as const};
  const catalog = current.scope === scope ? current.catalog : {kind: "idle" as const};
  useEffect(() => {
    mounted.current = true;
    current.select(endpoint, apiKeyEnv);
    changed();
    const dialog = element.current?.closest("dialog");
    const close = () => { current.cancel(); changed(); };
    dialog?.addEventListener("close", close);
    return () => {
      mounted.current = false;
      dialog?.removeEventListener("close", close);
      current.cancel();
    };
  }, [endpoint, apiKeyEnv]);
  const value = state.kind === "ready" ? state.value : null;
  const directory = catalog.kind === "ready" ? catalog.value : null;
  const models = directory?.status === "loaded" ? directory.models : [];
  const labels = Object.fromEntries(models.map(entry=>[entry.id,[entry.display_name,entry.owned_by].filter(Boolean).join(" · ")]));
  function update(value:string){
    if(!mounted.current||selectionScope.current!==scope||current.scope!==scope||current.catalog!==catalog)return;
    onSelect(value);
  }
  return <div className="provider-catalog" ref={element}>
    <div className="provider-model-field">
      <div className="provider-model-label"><span>{t("Model")}</span>{models.length > 0 && <small>{models.length} {t("available")}</small>}</div>
      <EditableCombo aria-label={t("Provider model")} value={model} options={models.map(entry=>entry.id)} labels={labels} disabled={current.busy} placeholder={t("Search models or enter a model ID")} onChange={event=>update(event.target.value)}/>
      <small>{t("Type to search by name, ID or provider, or enter a custom model ID.")}</small>
    </div>
    <div className="provider-catalog-actions">
      <button type="button" disabled={current.busy || !gatewayOrigin(endpoint)} onClick={() => { current.select(endpoint, apiKeyEnv); void current.load(invoke, changed); }}>{t("Load gateway models")}</button>
      {current.busy && <button type="button" onClick={() => { current.cancel(); changed(); }}>{t("Cancel gateway check")}</button>}
    </div>
    {catalog.kind === "checking" && <p className="connection-result pending" role="status">{t("Reading gateway models…")}</p>}
    {directory && (directory.status !== "loaded" ? <p className="connection-result error" role="alert">✕ {t(messages[directory.status])}</p> : <>
      <p className="connection-result success" role="status">✓ {models.length === 0 ? t("No models returned. Enter a model manually.") : t("{{value0}} models loaded. Choose one in Model or keep your manual model.", {value0:models.length})}</p>
      <small>{t("Source:")+" "}{gatewayOrigin(endpoint)} {t("· read")+" "}{new Date(catalog.kind === "ready" ? catalog.checkedAt : 0).toLocaleTimeString(i18n.language)}{t(". Catalog access does not verify upstream authentication.")}</small>
    </>)}
    <details><summary>{t("Connection checks")}</summary>
      {children}
      {identityCheck && <><button type="button" disabled={current.busy || !gatewayOrigin(endpoint)} onClick={() => { current.select(endpoint, apiKeyEnv); void current.check(invoke, changed); }}>{t("Check Magpie identity")}</button>
      <small>{t("Magpie identity check only. Read only; upstream authentication, billing and model availability remain unverified.")}</small>
      {!gatewayOrigin(endpoint) && <p>{t(messages.unsupported)}</p>}
      {state.kind === "checking" && <p className="connection-result pending" role="status">{t("Checking gateway API…")}</p>}
      {value && <p className={`connection-result ${value.status === "identified" ? "success" : "error"}`} role={value.status === "identified" ? "status" : "alert"}>{value.status === "identified"
        ? t("✓ Magpie {{value0}} identified · checked {{value1}}.", {value0:value.version,value1:new Date(state.kind === "ready" ? state.checkedAt : 0).toLocaleTimeString(i18n.language)})
        : `✕ ${t(messages[value.status])}`}</p>} </>}
    </details>
  </div>;
}
