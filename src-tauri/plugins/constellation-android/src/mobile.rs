use serde::de::DeserializeOwned;
use serde_json::{json, Value};
use tauri::{
    ipc::Channel,
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
    pub async fn location_permission(&self) -> crate::Result<Value> {
        self.0
            .run_mobile_plugin_async("locationPermission", json!({}))
            .await
            .map_err(Into::into)
    }

    pub async fn request_location_permission(&self) -> crate::Result<Value> {
        self.0
            .run_mobile_plugin_async("requestLocationPermission", json!({}))
            .await
            .map_err(Into::into)
    }

    pub async fn start_location_watch(
        &self,
        options: &Value,
        channel: Channel<Value>,
    ) -> crate::Result<Value> {
        self.0
            .run_mobile_plugin_async(
                "startLocationWatch",
                json!({ "options": options, "channel": channel }),
            )
            .await
            .map_err(Into::into)
    }

    pub async fn stop_location_watch(&self, watch_id: u64) -> crate::Result<Value> {
        self.0
            .run_mobile_plugin_async("stopLocationWatch", json!({ "watchId": watch_id }))
            .await
            .map_err(Into::into)
    }

    pub async fn current_location(&self, options: &Value) -> crate::Result<Value> {
        self.0
            .run_mobile_plugin_async("currentLocation", json!({ "options": options }))
            .await
            .map_err(Into::into)
    }

    pub async fn start(&self, request: &Value) -> crate::Result<Value> {
        self.0
            .run_mobile_plugin_async(
                "startBackgroundShare",
                json!({
                    "request": request.to_string(),
                }),
            )
            .await
            .map_err(Into::into)
    }

    pub async fn status(&self) -> crate::Result<Value> {
        self.0
            .run_mobile_plugin_async("backgroundShareStatus", json!({}))
            .await
            .map_err(Into::into)
    }

    pub async fn stop(&self, share_id: &str) -> crate::Result<Value> {
        self.0
            .run_mobile_plugin_async("stopBackgroundShare", json!({ "shareId": share_id }))
            .await
            .map_err(Into::into)
    }

    pub async fn set_visible(&self, visible: bool) -> crate::Result<Value> {
        self.0
            .run_mobile_plugin_async("setBackgroundVisibility", json!({ "visible": visible }))
            .await
            .map_err(Into::into)
    }

    pub async fn import_source_state(&self, state: &str) -> crate::Result<Value> {
        self.0
            .run_mobile_plugin_async("importSourceState", json!({ "state": state }))
            .await
            .map_err(Into::into)
    }

    pub async fn approve_return_link(&self, share_id: &str) -> crate::Result<Value> {
        self.0
            .run_mobile_plugin_async(
                "approveBackgroundReturnLink",
                json!({ "shareId": share_id }),
            )
            .await
            .map_err(Into::into)
    }

    pub async fn dismiss_return_offer(
        &self,
        share_id: &str,
        fingerprint: &str,
    ) -> crate::Result<Value> {
        self.0
            .run_mobile_plugin_async(
                "dismissBackgroundReturnOffer",
                json!({ "shareId": share_id, "fingerprint": fingerprint }),
            )
            .await
            .map_err(Into::into)
    }

    pub async fn set_viewer_name(
        &self,
        share_id: &str,
        fingerprint: &str,
        name: &str,
    ) -> crate::Result<Value> {
        self.0
            .run_mobile_plugin_async(
                "setBackgroundViewerName",
                json!({ "shareId": share_id, "fingerprint": fingerprint, "name": name }),
            )
            .await
            .map_err(Into::into)
    }

    pub async fn block_viewer(&self, share_id: &str, fingerprint: &str) -> crate::Result<Value> {
        self.0
            .run_mobile_plugin_async(
                "blockBackgroundViewer",
                json!({ "shareId": share_id, "fingerprint": fingerprint }),
            )
            .await
            .map_err(Into::into)
    }

    pub async fn take_shared_text(&self) -> crate::Result<Value> {
        self.0
            .run_mobile_plugin_async("takeSharedText", json!({}))
            .await
            .map_err(Into::into)
    }

    pub async fn load_private_state(&self) -> crate::Result<Value> {
        self.0
            .run_mobile_plugin_async("loadPrivateState", json!({}))
            .await
            .map_err(Into::into)
    }

    pub async fn save_private_state(&self, state: &str) -> crate::Result<Value> {
        self.0
            .run_mobile_plugin_async("savePrivateState", json!({ "state": state }))
            .await
            .map_err(Into::into)
    }
}
