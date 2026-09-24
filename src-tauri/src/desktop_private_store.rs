use secret_service::{blocking::SecretService, EncryptionType};
use serde_json::Value;
use std::collections::HashMap;

fn error() -> String {
    "Linux protected storage is unavailable or locked; sharing links cannot be saved.".into()
}

fn validate_state(state: &str) -> Result<(), String> {
    if state.is_empty() || state.len() > 131_072 {
        return Err("Protected location state is invalid.".into());
    }
    let value: Value = serde_json::from_str(state)
        .map_err(|_| "Protected location state is invalid.".to_string())?;
    if value.get("version").and_then(Value::as_u64) != Some(1) {
        return Err("Protected location state is invalid.".into());
    }
    Ok(())
}

fn attributes() -> HashMap<&'static str, &'static str> {
    HashMap::from([
        ("application", "space.taskyon.constellation"),
        ("record", "private-state-v1"),
    ])
}

pub fn load() -> Result<Option<String>, String> {
    let service = SecretService::connect(EncryptionType::Dh).map_err(|_| error())?;
    let collection = service.get_default_collection().map_err(|_| error())?;
    if collection.is_locked().map_err(|_| error())? {
        return Err(error());
    }
    let items = collection.search_items(attributes()).map_err(|_| error())?;
    if items.len() > 1 {
        return Err("Protected location state is ambiguous; no new identity was created.".into());
    }
    let Some(item) = items.first() else {
        return Ok(None);
    };
    if item.is_locked().map_err(|_| error())? {
        return Err(error());
    }
    let bytes = item.get_secret().map_err(|_| error())?;
    let state = String::from_utf8(bytes).map_err(|_| error())?;
    validate_state(&state)?;
    Ok(Some(state))
}

pub fn save(state: &str) -> Result<(), String> {
    validate_state(state)?;
    let service = SecretService::connect(EncryptionType::Dh).map_err(|_| error())?;
    let collection = service.get_default_collection().map_err(|_| error())?;
    if collection.is_locked().map_err(|_| error())? {
        return Err(error());
    }
    collection
        .create_item(
            "Constellation private sharing state",
            attributes(),
            state.as_bytes(),
            true,
            "application/json",
        )
        .map_err(|_| error())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::validate_state;

    #[test]
    fn only_accepts_bounded_private_state_records() {
        assert!(validate_state(r#"{"version":1,"privateKey":"synthetic"}"#).is_ok());
        assert!(validate_state(r#"{"version":2}"#).is_err());
        assert!(validate_state("not json").is_err());
    }
}
