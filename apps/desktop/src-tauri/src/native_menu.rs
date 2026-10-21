// Author: Jeff.Liu. Native editing/window commands stay native; app actions target one focused desktop.
use tauri::{
    menu::{Menu, MenuItem, MenuItemKind, PredefinedMenuItem, Submenu},
    Emitter, Manager,
};
const ACTIONS: &[&str] = &[
    "appearance",
    "new",
    "second-window",
    "project",
    "ssh",
    "hide",
    "reopen",
    "sidebar",
    "palette",
    "find",
    "larger",
    "smaller",
    "reset",
    "split-horizontal",
    "split-vertical",
    "zoom",
    "previous",
    "attention",
    "logs",
    "settings",
    "profiles",
    "keyboard-shortcuts",
    "updates",
    "paste-settings",
    "system-entry",
    "directory-reporting",
    "command-reporting",
    "launch-settings",
];
fn group(
    app: &tauri::AppHandle,
    title: &str,
    entries: &[(&str, &str)],
) -> tauri::Result<Submenu<tauri::Wry>> {
    let menu = Submenu::new(app, title, true)?;
    for (id, label) in entries {
        if id.is_empty() {
            menu.append(&PredefinedMenuItem::separator(app)?)?;
        } else {
            menu.append(&MenuItem::with_id(
                app,
                format!("yam-menu-{id}"),
                *label,
                true,
                None::<&str>,
            )?)?;
        }
    }
    Ok(menu)
}
pub(super) fn build(app: &tauri::AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    let defaults = Menu::default(app)?;
    let menu = Menu::new(app)?;
    let editing;
    let mut windows = None;
    let mut help = None;
    for (index, item) in defaults.items()?.into_iter().enumerate() {
        if let MenuItemKind::Submenu(submenu) = item {
            if submenu.id().as_ref() == tauri::menu::WINDOW_SUBMENU_ID {
                windows = Some(submenu);
            } else if submenu.id().as_ref() == tauri::menu::HELP_SUBMENU_ID {
                help = Some(submenu);
            } else if cfg!(target_os = "macos") && index == 0 {
                let count = submenu.items()?.len();
                if count > 0 { submenu.remove_at(count - 1)?; }
                submenu.insert(&MenuItem::with_id(app,"yam-menu-settings","Settings…",true,Some("CmdOrCtrl+,"))?,1)?;
                submenu.insert(&MenuItem::with_id(app,"yam-menu-updates","Check for updates…",true,None::<&str>)?,2)?;
                submenu.append(&MenuItem::with_id(app,"yam-stop-quit","Stop all tasks and quit",true,None::<&str>)?)?;
                submenu.append(&MenuItem::with_id(app,"yam-quit","Quit YAM",true,Some("CmdOrCtrl+Q"))?)?;
                menu.append(&submenu)?;
            }
        }
    }
    // Native edit actions keep OS clipboard and undo semantics in every language.
    editing = Some(Submenu::with_items(app,"Edit",true,&[
        &PredefinedMenuItem::undo(app,Some("Undo"))?, &PredefinedMenuItem::redo(app,Some("Redo"))?,
        &PredefinedMenuItem::separator(app)?, &PredefinedMenuItem::cut(app,Some("Cut"))?,
        &PredefinedMenuItem::copy(app,Some("Copy"))?, &PredefinedMenuItem::paste(app,Some("Paste"))?,
        &PredefinedMenuItem::select_all(app,Some("Select All"))?,
    ])?);
    let file = group(
        app,
        "File",
        &[
            ("new", "New session"),
            ("second-window", "Second terminal window"),
            ("", ""),
            ("project", "Add project folder…"),
            ("ssh", "Connect SSH…"),
            ("", ""),
            ("hide", "Hide active tab"),
            ("reopen", "Reopen last hidden tab"),
            ("", ""),
        ],
    )?;
    file.append(&PredefinedMenuItem::close_window(
        app,
        Some("Close window"),
    )?)?;
    #[cfg(not(target_os = "macos"))]
    {
        file.append(&MenuItem::with_id(
            app,
            "yam-menu-settings",
            "Settings…",
            true,
            None::<&str>,
        )?)?;
        file.append(&MenuItem::with_id(
            app,
            "yam-menu-updates",
            "Check for updates…",
            true,
            None::<&str>,
        )?)?;
        file.append(&MenuItem::with_id(
            app,
            "yam-quit",
            "Quit YAM",
            true,
            Some("Alt+F4"),
        )?)?;
    }
    menu.append(&file)?;
    if let Some(edit) = editing {
        menu.append(&edit)?;
    }
    let view = group(
        app,
        "View",
        &[
            ("sidebar", "Toggle sidebar"),
            ("palette", "Command palette"),
            ("find", "Find in terminal"),
            ("", ""),
            ("larger", "Larger terminal text"),
            ("smaller", "Smaller terminal text"),
            ("reset", "Reset terminal text size"),
        ],
    )?;
    #[cfg(target_os = "macos")]
    {
        view.append(&PredefinedMenuItem::separator(app)?)?;
        view.append(&PredefinedMenuItem::fullscreen(app, None)?)?;
    }
    menu.append(&view)?;
    menu.append(&group(
        app,
        "Session",
        &[
            ("split-horizontal", "Split right"),
            ("split-vertical", "Split down"),
            ("zoom", "Maximize / restore pane"),
            ("", ""),
            ("previous", "Previous session"),
            ("attention", "Next attention"),
            ("logs", "Search saved logs"),
            ("", ""),
        ],
    )?)?;
    menu.append(&group(
        app,
        "Settings",
        &[
            ("appearance", "Language and appearance…"),
            ("settings", "Terminal settings…"),
            ("profiles", "Terminal profiles…"),
            ("paste-settings", "Paste settings"),
            ("keyboard-shortcuts", "Keyboard shortcuts…"),
            ("launch-settings", "Launch templates and defaults"),
            ("", ""),
            ("directory-reporting", "Zsh directory reporting…"),
            ("command-reporting", "Zsh command status reporting…"),
            ("system-entry", "System entry"),
            ("updates", "Check for updates…"),
        ],
    )?)?;
    if let Some(window) = windows {
        menu.append(&window)?;
    }
    if let Some(help) = help {
        menu.append(&help)?;
    }
    Ok(menu)
}
fn target<'a>(action: &str, focused: &'a str) -> &'a str {
    if matches!(
        action,
        "appearance"
            | "settings"
            | "profiles"
            | "keyboard-shortcuts"
            | "updates"
            | "project"
            | "ssh"
            | "paste-settings"
            | "system-entry"
            | "directory-reporting"
            | "command-reporting"
            | "launch-settings"
    ) {
        "main"
    } else {
        focused
    }
}
pub(super) fn route(app: &tauri::AppHandle, id: &str) {
    let Some(action) = id
        .strip_prefix("yam-menu-")
        .filter(|value| ACTIONS.contains(value))
    else {
        return;
    };
    for label in ["main", "terminal-secondary"] {
        if let Some(window) = app.get_webview_window(label) {
            if window.is_focused().unwrap_or(false) {
                let destination = target(action, label);
                if destination != label {
                    let Some(main) = app.get_webview_window(destination) else {
                        return;
                    };
                    if main
                        .show()
                        .and_then(|_| main.unminimize())
                        .and_then(|_| main.set_focus())
                        .is_err()
                    {
                        return;
                    }
                }
                let _ = app.emit_to(destination, "native-menu", action);
                break;
            }
        }
    }
}

fn menu_caption(text:&str,chinese:bool)->String {
    const CAPTIONS:&[(&str,&str)]=&[("YAM — second terminal window","YAM — 第二终端窗口"),("File","文件"),("Edit","编辑"),("View","显示"),("Session","会话"),("Settings","设置"),("Window","窗口"),("Help","帮助"),("Settings…","设置…"),("Check for updates…","检查更新…"),("Stop all tasks and quit","停止全部任务并退出"),("Quit YAM","退出 YAM"),("Close window","关闭窗口"),("Close Window","关闭窗口"),("Minimize","最小化"),("Zoom","缩放"),("Undo","撤销"),("Redo","重做"),("Cut","剪切"),("Copy","复制"),("Paste","粘贴"),("Select All","全选"),("Enter Full Screen","进入全屏"),("Exit Full Screen","退出全屏"),("Hide YAM","隐藏 YAM"),("Hide Others","隐藏其他应用"),("Show All","显示全部"),("Services","服务"),("About YAM","关于 YAM")];
    CAPTIONS.iter().find(|(en,zh)|text==*en||text==*zh).map(|(en,zh)|if chinese{*zh}else{*en}).unwrap_or(text).into()
}
fn action_caption(id:&str,text:&str,labels:&std::collections::HashMap<String,String>,chinese:bool)->String{
    id.strip_prefix("yam-menu-").and_then(|action|labels.get(action)).cloned().unwrap_or_else(||menu_caption(text,chinese))
}
fn translate_items(items:Vec<MenuItemKind<tauri::Wry>>,chinese:bool,labels:&std::collections::HashMap<String,String>)->Result<(),String>{
    for item in items {
        match item {
            MenuItemKind::Submenu(item)=>{item.set_text(menu_caption(&item.text().map_err(|_|"Menu unavailable")?,chinese)).map_err(|_|"Menu unavailable")?;translate_items(item.items().map_err(|_|"Menu unavailable")?,chinese,labels)?;},
            MenuItemKind::MenuItem(item)=>{item.set_text(action_caption(item.id().as_ref(),&item.text().map_err(|_|"Menu unavailable")?,labels,chinese)).map_err(|_|"Menu unavailable")?;},
            MenuItemKind::Predefined(item)=>{item.set_text(menu_caption(&item.text().map_err(|_|"Menu unavailable")?,chinese)).map_err(|_|"Menu unavailable")?;},
            _=>{}
        }
    }
    Ok(())
}

fn desktop_theme(value:&str)->Result<Option<tauri::Theme>,String>{
    match value {"system"=>Ok(None),"light"=>Ok(Some(tauri::Theme::Light)),"dark"=>Ok(Some(tauri::Theme::Dark)),_=>Err("Invalid desktop theme".into())}
}

#[tauri::command]
pub(super) fn native_menu_labels(
    app: tauri::AppHandle,
    webview: tauri::Webview,
    labels: std::collections::HashMap<String, String>,
    locale: Option<String>,
    theme: Option<String>,
) -> Result<(), String> {
    let label = webview.label();
    if !["main", "terminal-secondary"].contains(&label)
        || webview.window().label() != label
        || !webview.window().is_focused().unwrap_or(false)
    {
        return Ok(());
    }
    if labels.len() != ACTIONS.len()
        || labels.iter().any(|(key, value)| {
            !ACTIONS.contains(&key.as_str())
                || value.is_empty()
                || value.len() > 180
                || value.chars().any(char::is_control)
        })
    {
        return Err("Invalid menu labels".into());
    }
    if locale.as_deref().is_some_and(|value| !matches!(value,"en"|"zh-CN")) { return Err("Invalid menu locale".into()); }
    if let Some(theme)=theme {
        let value=desktop_theme(&theme)?;
        for (label,window) in app.webview_windows(){if ["main","terminal-secondary"].contains(&label.as_str()){window.set_theme(value).map_err(|_|"Window appearance unavailable")?;}}
    }
    let menu = app.menu().ok_or("Menu unavailable")?;
    if let Some(window)=app.get_webview_window("terminal-secondary"){window.set_title(&menu_caption("YAM — second terminal window",locale.as_deref()==Some("zh-CN"))).map_err(|_|"Window title unavailable")?;}
    translate_items(menu.items().map_err(|_| "Menu unavailable")?,locale.as_deref()==Some("zh-CN"),&labels)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn language_theme_system_clears_native_override_and_unknown_values_are_refused(){
        assert_eq!(desktop_theme("system").unwrap(),None);
        assert_eq!(desktop_theme("dark").unwrap(),Some(tauri::Theme::Dark));
        assert_eq!(desktop_theme("light").unwrap(),Some(tauri::Theme::Light));
        assert!(desktop_theme("arbitrary").is_err());
    }
    #[test]
    fn language_theme_nested_actions_use_ids_and_titles_follow_locale(){
        let labels=std::collections::HashMap::from([("appearance".into(),"语言与外观".into())]);
        assert_eq!(action_caption("yam-menu-appearance","Language and appearance…",&labels,true),"语言与外观");
        assert_eq!(action_caption("unknown","literal user text",&labels,true),"literal user text");
        assert_eq!(menu_caption("YAM — second terminal window",true),"YAM — 第二终端窗口");
    }
    #[test]
    fn locale_captions_round_trip_without_changing_unknown_identifiers(){
        assert_eq!(menu_caption("File",true),"文件");assert_eq!(menu_caption("文件",false),"File");assert_eq!(menu_caption("codex",true),"codex");
    }
    #[test]
    fn global_settings_open_the_right_panel_in_main_while_session_actions_stay_focused() {
        for action in [
            "settings",
            "profiles",
            "keyboard-shortcuts",
            "updates",
            "project",
            "ssh",
        ] {
            assert_eq!(target(action, "terminal-secondary"), "main");
        }
        for action in ["new", "find", "hide", "split-horizontal", "sidebar"] {
            assert_eq!(target(action, "terminal-secondary"), "terminal-secondary");
            assert_eq!(target(action, "main"), "main");
        }
    }
}
