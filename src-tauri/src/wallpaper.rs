//! "Song as desktop background": Aura draws the current song into a JPEG (in the page, on a
//! canvas) and sets it as the Windows wallpaper. Your own wallpaper is remembered first and
//! put back when the setting is turned off or Aura closes.

use std::path::PathBuf;

use windows_sys::Win32::UI::WindowsAndMessaging::{
    SystemParametersInfoW, SPIF_SENDCHANGE, SPIF_UPDATEINIFILE, SPI_GETDESKWALLPAPER, SPI_SETDESKWALLPAPER,
};

fn dir() -> PathBuf {
    dirs::config_dir().unwrap_or_default().join("prism")
}

/// Where your own wallpaper's path is kept while Aura's is showing.
fn saved_path_file() -> PathBuf {
    dir().join("original-wallpaper.txt")
}

fn current() -> String {
    let mut buf = [0u16; 1024];
    unsafe { SystemParametersInfoW(SPI_GETDESKWALLPAPER, buf.len() as u32, buf.as_mut_ptr().cast(), 0) };
    let len = buf.iter().position(|&c| c == 0).unwrap_or(0);
    String::from_utf16_lossy(&buf[..len])
}

fn set(path: &str) -> Result<(), String> {
    let mut wide: Vec<u16> = path.encode_utf16().chain(std::iter::once(0)).collect();
    let ok = unsafe {
        SystemParametersInfoW(SPI_SETDESKWALLPAPER, 0, wide.as_mut_ptr().cast(), SPIF_UPDATEINIFILE | SPIF_SENDCHANGE)
    };
    if ok == 0 { Err("Windows refused to change the wallpaper".into()) } else { Ok(()) }
}

/// Sets the song image (JPEG bytes from the page) as the wallpaper.
#[tauri::command]
pub async fn set_song_wallpaper(image: Vec<u8>) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        std::fs::create_dir_all(dir()).map_err(|e| e.to_string())?;
        let now = current();
        // remember your wallpaper once (not Aura's own images)
        if !saved_path_file().exists() && !now.contains("aura-wallpaper") {
            std::fs::write(saved_path_file(), &now).map_err(|e| e.to_string())?;
        }
        // alternate file names: Windows may keep showing a cached image for an unchanged path
        let name = if now.ends_with("aura-wallpaper-a.jpg") { "aura-wallpaper-b.jpg" } else { "aura-wallpaper-a.jpg" };
        let path = dir().join(name);
        std::fs::write(&path, image).map_err(|e| e.to_string())?;
        set(&path.to_string_lossy())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Puts your own wallpaper back.
#[tauri::command]
pub async fn restore_wallpaper() -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(restore_now).await.map_err(|e| e.to_string())?
}

pub fn restore_now() -> Result<(), String> {
    let Ok(original) = std::fs::read_to_string(saved_path_file()) else { return Ok(()) };
    set(&original)?;
    let _ = std::fs::remove_file(saved_path_file());
    Ok(())
}
