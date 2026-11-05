fn main() {
    // The crate version is a fixed placeholder. The shipped version comes from the root package.json
    // through tauri.conf.json's "version": "../package.json"; Tauri uses it for the bundle, installers,
    // and the Windows version resource. Do not add a second release-version check here.
    tauri_build::build()
}
