import {t} from "./i18n";
// Author: Jeff.Liu.
export default function SystemEntrySettings(props: {showTitle?:boolean;enabled: boolean; registered: boolean; available: boolean; busy: boolean; warning: string; onChange: (enabled: boolean) => void}) {
  return <section className="system-entry-settings" aria-label={t("System entry settings")}>
    {props.showTitle!==false&&<h3>{t("System entry")}</h3>}
    <label><input type="checkbox" checked={props.enabled} disabled={props.busy||!props.available} onChange={event=>props.onChange(event.target.checked)}/>{t("Enable global summon: CommandOrControl+Shift+Y")}</label>
    <p>{props.registered?t("Shortcut registered by this owner."):t("Shortcut is not registered.")}</p>
    <p>{t("Open the normal YAM window if the tray or shortcut is unavailable. Closing YAM keeps tasks running; only Stop all tasks and quit stops them.")}</p>
    {props.warning&&<p role="alert">{t(props.warning)}</p>}
  </section>;
}
