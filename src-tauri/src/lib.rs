#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_deep_link::init())
        .setup(|_app| {
            #[cfg(mobile)]
            _app.handle().plugin(tauri_plugin_geolocation::init())?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Constellation");
}
