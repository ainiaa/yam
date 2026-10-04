// Author: Jeff.Liu.
export default function SystemEntrySettings(props: {enabled: boolean; registered: boolean; available: boolean; busy: boolean; warning: string; onChange: (enabled: boolean) => void}) {
  return <section className="system-entry-settings" aria-label="System entry settings">
    <h3>System entry</h3>
    <label><input type="checkbox" checked={props.enabled} disabled={props.busy||!props.available} onChange={event=>props.onChange(event.target.checked)}/>Enable global summon: CommandOrControl+Shift+Y</label>
    <p>{props.registered?"Shortcut registered by this owner.":"Shortcut is not registered."}</p>
    <p>Open the normal YAM window if the tray or shortcut is unavailable. Closing YAM keeps tasks running; only Stop all tasks and quit stops them.</p>
    {props.warning&&<p role="alert">{props.warning}</p>}
  </section>;
}
