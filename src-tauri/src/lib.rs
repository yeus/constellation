#[cfg(target_os = "android")]
use tauri_plugin_constellation_android::ConstellationAndroidExt;

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
async fn android_stop_background_share(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    #[cfg(target_os = "android")]
    return app
        .constellation_android()
        .stop()
        .map_err(|error| error.to_string());
    #[cfg(not(target_os = "android"))]
    {
        let _ = app;
        Err("Android background sharing is unavailable.".into())
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
        ])
        .setup(|_app| {
            #[cfg(mobile)]
            _app.handle().plugin(tauri_plugin_geolocation::init())?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Constellation");
}
