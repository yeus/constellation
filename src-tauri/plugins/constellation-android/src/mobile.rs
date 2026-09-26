use serde::de::DeserializeOwned;
use serde_json::{json, Value};
use tauri::{
    plugin::{PluginApi, PluginHandle},
    AppHandle, Runtime,
};

pub fn init<R: Runtime, C: DeserializeOwned>(
    _app: &AppHandle<R>,
    api: PluginApi<R, C>,
) -> crate::Result<ConstellationAndroid<R>> {
    let handle = api.register_android_plugin(
        "space.taskyon.constellation.plugin",
        "ConstellationAndroidPlugin",
    )?;
    Ok(ConstellationAndroid(handle))
}

pub struct ConstellationAndroid<R: Runtime>(PluginHandle<R>);

impl<R: Runtime> ConstellationAndroid<R> {
    pub fn start(&self, request: &Value) -> crate::Result<Value> {
        self.0
            .run_mobile_plugin(
                "startBackgroundShare",
                json!({
                    "request": request.to_string(),
                }),
            )
            .map_err(Into::into)
    }

    pub fn status(&self) -> crate::Result<Value> {
        self.0
            .run_mobile_plugin("backgroundShareStatus", json!({}))
            .map_err(Into::into)
    }

    pub fn stop(&self, share_id: &str) -> crate::Result<Value> {
        self.0
            .run_mobile_plugin("stopBackgroundShare", json!({ "shareId": share_id }))
            .map_err(Into::into)
    }

    pub fn set_visible(&self, visible: bool) -> crate::Result<Value> {
        self.0
            .run_mobile_plugin("setBackgroundVisibility", json!({ "visible": visible }))
            .map_err(Into::into)
    }

    pub fn import_source_state(&self, state: &str) -> crate::Result<Value> {
        self.0
            .run_mobile_plugin("importSourceState", json!({ "state": state }))
            .map_err(Into::into)
    }

    pub fn set_viewer_name(
        &self,
        share_id: &str,
        fingerprint: &str,
        name: &str,
    ) -> crate::Result<Value> {
        self.0
            .run_mobile_plugin(
                "setBackgroundViewerName",
                json!({ "shareId": share_id, "fingerprint": fingerprint, "name": name }),
            )
            .map_err(Into::into)
    }

    pub fn block_viewer(&self, share_id: &str, fingerprint: &str) -> crate::Result<Value> {
        self.0
            .run_mobile_plugin(
                "blockBackgroundViewer",
                json!({ "shareId": share_id, "fingerprint": fingerprint }),
            )
            .map_err(Into::into)
    }

    pub fn take_shared_text(&self) -> crate::Result<Value> {
        self.0
            .run_mobile_plugin("takeSharedText", json!({}))
            .map_err(Into::into)
    }

    pub fn load_private_state(&self) -> crate::Result<Value> {
        self.0
            .run_mobile_plugin("loadPrivateState", json!({}))
            .map_err(Into::into)
    }

    pub fn save_private_state(&self, state: &str) -> crate::Result<Value> {
        self.0
            .run_mobile_plugin("savePrivateState", json!({ "state": state }))
            .map_err(Into::into)
    }
}
