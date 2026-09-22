use tauri::{
    plugin::{Builder, TauriPlugin},
    Manager, Runtime,
};

#[cfg(mobile)]
mod mobile;
mod error;

pub use error::{Error, Result};

#[cfg(mobile)]
use mobile::ConstellationAndroid;

pub trait ConstellationAndroidExt<R: Runtime> {
    fn constellation_android(&self) -> &ConstellationAndroid<R>;
}

impl<R: Runtime, T: Manager<R>> ConstellationAndroidExt<R> for T {
    fn constellation_android(&self) -> &ConstellationAndroid<R> {
        self.state::<ConstellationAndroid<R>>().inner()
    }
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("constellation-android")
        .setup(|app, api| {
            #[cfg(mobile)]
            app.manage(mobile::init(app, api)?);
            Ok(())
        })
        .build()
}
