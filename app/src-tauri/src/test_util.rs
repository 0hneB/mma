//! Shared fixtures for the `*.test.rs` modules.

/// Build a [`crate::location_store::LocationPatch`] from only the fields it sets.
/// Each value is wrapped in one `Some`, so nullable fields take the inner option:
/// `patch!(pano_id: None)` clears the pano id.
macro_rules! patch {
    ($($field:ident: $value:expr),* $(,)?) => {
        crate::location_store::LocationPatch {
            $($field: Some($value),)*
            ..Default::default()
        }
    };
}

pub(crate) use patch;
