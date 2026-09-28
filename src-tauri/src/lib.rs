#[cfg(target_os = "android")]
use tauri_plugin_constellation_android::ConstellationAndroidExt;

#[cfg(target_os = "android")]
#[tauri::command]
async fn android_location_permission(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    app.constellation_android()
        .location_permission()
        .await
        .map_err(|error| error.to_string())
}

#[cfg(target_os = "android")]
#[tauri::command]
async fn android_request_location_permission(
    app: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    app.constellation_android()
        .request_location_permission()
        .await
        .map_err(|error| error.to_string())
}

#[cfg(target_os = "android")]
#[tauri::command]
async fn android_start_location_watch(
    app: tauri::AppHandle,
    options: serde_json::Value,
    channel: tauri::ipc::Channel<serde_json::Value>,
) -> Result<serde_json::Value, String> {
    app.constellation_android()
        .start_location_watch(&options, channel)
        .await
        .map_err(|error| error.to_string())
}

#[cfg(target_os = "android")]
#[tauri::command]
async fn android_stop_location_watch(
    app: tauri::AppHandle,
    watch_id: u64,
) -> Result<serde_json::Value, String> {
    app.constellation_android()
        .stop_location_watch(watch_id)
        .await
        .map_err(|error| error.to_string())
}

#[cfg(target_os = "android")]
#[tauri::command]
async fn android_current_location(
    app: tauri::AppHandle,
    options: serde_json::Value,
) -> Result<serde_json::Value, String> {
    app.constellation_android()
        .current_location(&options)
        .await
        .map_err(|error| error.to_string())
}

#[cfg(all(target_os = "android", debug_assertions))]
fn trace_android_save_response(app: &tauri::AppHandle) {
    use tauri::Manager;

    match app.get_webview_window("main") {
        Some(webview) => {
            let accepted = webview
                .eval("console.log('[constellation-ipc] native-save-eval-received')")
                .is_ok();
            eprintln!(
                "constellation-ipc-eval-{}",
                if accepted { "accepted" } else { "failed" }
            );
        }
        None => eprintln!("constellation-ipc-eval-missing-window"),
    }
}

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
        .await
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
    {
        let result = app
            .constellation_android()
            .status()
            .await
            .map_err(|error| error.to_string());
        #[cfg(debug_assertions)]
        if let Ok(status) = &result {
            eprintln!(
                "constellation-ipc-status-bytes-{}",
                status.to_string().len()
            );
        }
        return result;
    }
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
        .await
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
        .await
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
        .await
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
        .await
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
        .await
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
        .await
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
        .await
        .map_err(|error| error.to_string());
    #[cfg(not(target_os = "android"))]
    {
        let _ = app;
        Err("Android protected storage is unavailable.".into())
    }
}

#[tauri::command]
async fn android_save_private_state(app: tauri::AppHandle, state: String) -> Result<(), String> {
    #[cfg(target_os = "android")]
    {
        #[cfg(debug_assertions)]
        eprintln!("constellation-ipc-save-entered");
        let result = app
            .constellation_android()
            .save_private_state(&state)
            .await
            .map_err(|error| error.to_string());
        #[cfg(debug_assertions)]
        eprintln!("constellation-ipc-save-plugin-returned");
        result?;
        #[cfg(debug_assertions)]
        trace_android_save_response(&app);
        return Ok(());
    }
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
            #[cfg(target_os = "android")]
            android_location_permission,
            #[cfg(target_os = "android")]
            android_request_location_permission,
            #[cfg(target_os = "android")]
            android_start_location_watch,
            #[cfg(target_os = "android")]
            android_stop_location_watch,
            #[cfg(target_os = "android")]
            android_current_location,
        ])
        .setup(|_app| {
            #[cfg(target_os = "ios")]
            _app.handle().plugin(tauri_plugin_geolocation::init())?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Constellation");
}
