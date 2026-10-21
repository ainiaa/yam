// Author: Jeff.Liu.
use std::{
    fs,
    io::{BufRead, BufReader, Read},
    path::Path,
};

pub(super) fn new_id() -> Result<String, String> {
    let value = crate::agent_bridge::credential()?;
    Ok(format!(
        "{}-{}-4{}-8{}-{}",
        &value[..8],
        &value[8..12],
        &value[13..16],
        &value[17..20],
        &value[20..32]
    ))
}
fn regular(path: &Path) -> Result<fs::File, String> {
    if !fs::symlink_metadata(path)
        .map_err(|_| "Gemini history is unavailable")?
        .is_file()
    {
        return Err("Gemini history must be a regular file".into());
    }
    let mut options = fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW);
    }
    options
        .open(path)
        .map_err(|_| "Cannot read Gemini history".into())
}
fn same_project(original: &str, cwd: &Path) -> bool {
    if Path::new(original).canonicalize().ok().as_deref() == Some(cwd) {
        return true;
    }
    if cfg!(any(windows, target_os = "macos")) {
        original.replace('\\', "/").to_lowercase()
            == cwd.to_string_lossy().replace('\\', "/").to_lowercase()
    } else {
        false
    }
}
// Gemini 0.64 stores the project path beside chats; unverifiable legacy layouts fail closed.
pub(super) fn validate(config: &Path, cwd: &Path, id: &str) -> Result<(), String> {
    if !crate::valid_resume_id(id) {
        return Err("Invalid Gemini conversation ID".into());
    }
    let cwd = cwd
        .canonicalize()
        .map_err(|_| "Original Gemini directory is unavailable")?;
    let tmp = config.join("tmp");
    for dir in [config, &tmp] {
        if !fs::symlink_metadata(dir)
            .map_err(|_| "Gemini conversation storage is unavailable")?
            .is_dir()
        {
            return Err("Gemini history directory is invalid".into());
        }
    }
    let projects = fs::read_dir(&tmp).map_err(|_| "Gemini conversation storage is unavailable")?;
    let mut found = false;
    let mut inspected = 0;
    for (index, entry) in projects.enumerate() {
        if index >= 4096 {
            return Err("Gemini project lookup exceeded its scan budget".into());
        }
        let entry = entry.map_err(|_| "Cannot inspect Gemini projects")?;
        if !entry
            .file_type()
            .map_err(|_| "Cannot inspect Gemini project")?
            .is_dir()
        {
            continue;
        }
        let marker = entry.path().join(".project_root");
        if !marker.exists() {
            continue;
        }
        let mut original = String::new();
        regular(&marker)?
            .take(65537)
            .read_to_string(&mut original)
            .map_err(|_| "Invalid Gemini project identity")?;
        if original.len() > 65536 || !same_project(original.trim(), &cwd) {
            continue;
        }
        let chats = entry.path().join("chats");
        if !chats.exists() {
            continue;
        }
        if !fs::symlink_metadata(&chats)
            .map_err(|_| "Cannot inspect Gemini chats")?
            .is_dir()
        {
            return Err("Gemini chats directory is invalid".into());
        }
        for file in fs::read_dir(chats).map_err(|_| "Cannot inspect Gemini chats")? {
            inspected += 1;
            if inspected > 4096 {
                return Err("Gemini session lookup exceeded its scan budget".into());
            }
            let file = file.map_err(|_| "Cannot inspect Gemini session")?;
            let name = file.file_name().to_string_lossy().into_owned();
            if !name.contains(&id[..8].to_ascii_lowercase())
                || !(name.ends_with(".jsonl") || name.ends_with(".json"))
            {
                continue;
            }
            let mut lines = BufReader::new(regular(&file.path())?.take(1024 * 1024)).lines();
            let first = lines
                .next()
                .ok_or("Gemini history metadata is missing")?
                .map_err(|_| "Cannot read Gemini metadata")?;
            let metadata: serde_json::Value =
                serde_json::from_str(&first).map_err(|_| "Invalid Gemini conversation metadata")?;
            if metadata["sessionId"].as_str() != Some(id) {
                continue;
            }
            if metadata["projectHash"]
                .as_str()
                .is_none_or(|v| v.is_empty())
                || metadata["kind"] == "subagent"
            {
                return Err("Gemini conversation is not a verifiable main session".into());
            }
            let mut user = metadata["messages"]
                .as_array()
                .is_some_and(|messages| messages.iter().any(|message| message["type"] == "user"));
            for line in lines {
                let line = line.map_err(|_| "Cannot read Gemini conversation")?;
                let value: serde_json::Value = serde_json::from_str(&line)
                    .map_err(|_| "Invalid Gemini conversation record")?;
                if value["type"] == "user" {
                    user = true;
                    break;
                }
            }
            if !user {
                return Err("Gemini conversation has no saved user messages".into());
            }
            if found {
                return Err("Gemini conversation identity is ambiguous".into());
            }
            found = true;
        }
    }
    if found {
        Ok(())
    } else {
        Err("Original Gemini conversation was not found; no new conversation was started".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    const ID: &str = "446cd50d-099d-4a12-bcbc-5ab13ffa6944";
    #[test]
    fn gemini_native_resume_requires_exact_id_original_project_and_main_history() {
        let root = std::env::temp_dir().join(crate::next_session_id());
        let cwd = root.join("project");
        let config = root.join(".gemini");
        let project = config.join("tmp/project-slug");
        let chats = project.join("chats");
        std::fs::create_dir_all(&cwd).unwrap();
        std::fs::create_dir_all(&chats).unwrap();
        std::fs::write(project.join(".project_root"), cwd.to_str().unwrap()).unwrap();
        let file = chats.join("session-timestamp-446cd50d.jsonl");
        let metadata = serde_json::json!({"sessionId":ID,"projectHash":"native-project-hash"});
        std::fs::write(
            &file,
            format!(
                "{metadata}\n{{\"id\":\"message\",\"type\":\"user\",\"content\":\"private\"}}\n"
            ),
        )
        .unwrap();
        assert!(validate(&config, &cwd, ID).is_ok());
        assert!(validate(&config, &root, ID).is_err());
        assert!(validate(&config, &cwd, "--last").is_err());
        for bad in [
            serde_json::json!({"sessionId":"other","projectHash":"hash"}),
            serde_json::json!({"sessionId":ID,"kind":"subagent"}),
            serde_json::json!({"sessionId":ID}),
        ] {
            std::fs::write(&file, format!("{bad}\n")).unwrap();
            assert!(validate(&config, &cwd, ID).is_err());
        }
        std::fs::write(&file, format!("{metadata}\n")).unwrap();
        assert!(validate(&config, &cwd, ID).is_err());
        std::fs::remove_file(file).unwrap();
        assert!(validate(&config, &cwd, ID).is_err());
        let first = new_id().unwrap();
        let second = new_id().unwrap();
        assert!(crate::valid_resume_id(&first));
        assert_ne!(first, second);
        assert_eq!(&first[14..15], "4");
        std::fs::remove_dir_all(root).unwrap();
    }
}
