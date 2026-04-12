fn main() {
    #[cfg(feature = "napi-export")]
    napi_build::setup();
}
