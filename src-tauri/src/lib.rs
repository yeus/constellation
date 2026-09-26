#[cfg(target_os = "android")]
use tauri_plugin_constellation_android::ConstellationAndroidExt;

#[cfg(target_os = "linux")]
mod desktop_private_store;

#[tauri::command]
async fn android_start_background_share(
    app: tauri::AppHandle,
    request: serde_json::Value,
) -> Result<serde_json::Value, String> {
    #[cfg(target_os = "android")]
    return app
        .constellation_android()
        .start(&request)
        .map_err(|error| error.to_string());
    #[cfg(not(target_os = "android"))]
    {
        let _ = (app, request);
        Err("Android background sharing is unavailable.".into())
    }
}

#[tauri::command]
async fn android_background_share_status(
    app: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    #[cfg(target_os = "android")]
    return app
        .constellation_android()
        .status()
        .map_err(|error| error.to_string());
    #[cfg(not(target_os = "android"))]
    {
        let _ = app;
        Err("Android background sharing is unavailable.".into())
    }
}

#[tauri::command]
async fn android_stop_background_share(
    app: tauri::AppHandle,
    share_id: String,
) -> Result<serde_json::Value, String> {
    #[cfg(target_os = "android")]
    return app
        .constellation_android()
        .stop(&share_id)
        .map_err(|error| error.to_string());
    #[cfg(not(target_os = "android"))]
    {
        let _ = (app, share_id);
        Err("Android background sharing is unavailable.".into())
    }
}

#[tauri::command]
async fn android_set_background_visibility(
    app: tauri::AppHandle,
    visible: bool,
) -> Result<serde_json::Value, String> {
    #[cfg(target_os = "android")]
    return app
        .constellation_android()
        .set_visible(visible)
        .map_err(|error| error.to_string());
    #[cfg(not(target_os = "android"))]
    {
        let _ = (app, visible);
        Err("Android background sharing is unavailable.".into())
    }
}

#[tauri::command]
async fn android_import_source_state(
    app: tauri::AppHandle,
    state: String,
) -> Result<serde_json::Value, String> {
    #[cfg(target_os = "android")]
    return app
        .constellation_android()
        .import_source_state(&state)
        .map_err(|error| error.to_string());
    #[cfg(not(target_os = "android"))]
    {
        let _ = (app, state);
        Err("Android protected storage is unavailable.".into())
    }
}

#[tauri::command]
async fn android_set_background_viewer_name(
    app: tauri::AppHandle,
    share_id: String,
    fingerprint: String,
    name: String,
) -> Result<serde_json::Value, String> {
    #[cfg(target_os = "android")]
    return app
        .constellation_android()
        .set_viewer_name(&share_id, &fingerprint, &name)
        .map_err(|error| error.to_string());
    #[cfg(not(target_os = "android"))]
    {
        let _ = (app, share_id, fingerprint, name);
        Err("Android background sharing is unavailable.".into())
    }
}

#[tauri::command]
async fn android_block_background_viewer(
    app: tauri::AppHandle,
    share_id: String,
    fingerprint: String,
) -> Result<serde_json::Value, String> {
    #[cfg(target_os = "android")]
    return app
        .constellation_android()
        .block_viewer(&share_id, &fingerprint)
        .map_err(|error| error.to_string());
    #[cfg(not(target_os = "android"))]
    {
        let _ = (app, share_id, fingerprint);
        Err("Android background sharing is unavailable.".into())
    }
}

#[tauri::command]
async fn android_take_shared_text(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    #[cfg(target_os = "android")]
    return app
        .constellation_android()
        .take_shared_text()
        .map_err(|error| error.to_string());
    #[cfg(not(target_os = "android"))]
    {
        let _ = app;
        Err("Android text sharing is unavailable.".into())
    }
}

#[tauri::command]
async fn android_load_private_state(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    #[cfg(target_os = "android")]
    return app
        .constellation_android()
        .load_private_state()
        .map_err(|error| error.to_string());
    #[cfg(not(target_os = "android"))]
    {
        let _ = app;
        Err("Android protected storage is unavailable.".into())
    }
}

#[tauri::command]
async fn android_save_private_state(
    app: tauri::AppHandle,
    state: String,
) -> Result<serde_json::Value, String> {
    #[cfg(target_os = "android")]
    return app
        .constellation_android()
        .save_private_state(&state)
        .map_err(|error| error.to_string());
    #[cfg(not(target_os = "android"))]
    {
        let _ = (app, state);
        Err("Android protected storage is unavailable.".into())
    }
}

#[tauri::command]
async fn desktop_load_private_state() -> Result<serde_json::Value, String> {
    #[cfg(target_os = "linux")]
    {
        let state = tauri::async_runtime::spawn_blocking(desktop_private_store::load)
            .await
            .map_err(|_| "Protected location state could not be opened.".to_string())??;
        return Ok(serde_json::json!({ "state": state.unwrap_or_default() }));
    }
    #[cfg(not(target_os = "linux"))]
    Err("Desktop protected storage is unavailable.".into())
}

#[tauri::command]
async fn desktop_save_private_state(state: String) -> Result<(), String> {
    #[cfg(target_os = "linux")]
    {
        return tauri::async_runtime::spawn_blocking(move || desktop_private_store::save(&state))
            .await
            .map_err(|_| "Protected location state could not be saved.".to_string())?;
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = state;
        Err("Desktop protected storage is unavailable.".into())
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default();
    #[cfg(target_os = "android")]
    let builder = builder.plugin(tauri_plugin_constellation_android::init());
    builder
        .plugin(tauri_plugin_deep_link::init())
        .invoke_handler(tauri::generate_handler![
            android_start_background_share,
            android_background_share_status,
            android_stop_background_share,
            android_set_background_visibility,
            android_import_source_state,
            android_set_background_viewer_name,
            android_block_background_viewer,
            android_take_shared_text,
            android_load_private_state,
            android_save_private_state,
            desktop_load_private_state,
            desktop_save_private_state,
        ])
        .setup(|_app| {
            #[cfg(mobile)]
            _app.handle().plugin(tauri_plugin_geolocation::init())?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Constellation");
}
