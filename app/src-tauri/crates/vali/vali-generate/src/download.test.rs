use super::{downloaded_country_codes, outdated, MetadataFile, NetDateTime, R2Object};

fn time(s: &str) -> NetDateTime {
    NetDateTime::parse(s).expect("valid timestamp")
}

fn remote(key: &str, uploaded: &str) -> R2Object {
    R2Object {
        key: key.to_string(),
        uploaded: time(uploaded),
        size: Some(10),
    }
}

fn local(name: &str, written: &str) -> MetadataFile {
    MetadataFile {
        name: name.to_string(),
        last_write_time_utc: time(written),
    }
}

#[test]
fn a_missing_local_file_is_outdated() {
    let remote = vec![remote("FR/paris.bin", "2026-01-01T00:00:00Z")];
    assert_eq!(outdated(&remote, &[]).len(), 1);
}

#[test]
fn a_newer_upload_is_outdated_and_an_older_one_is_not() {
    let r = vec![remote("FR/paris.bin", "2026-02-01T00:00:00Z")];
    assert!(outdated(&r, &[local("paris", "2026-01-01T00:00:00Z")]).len() == 1);
    assert!(outdated(&r, &[local("paris", "2026-03-01T00:00:00Z")]).is_empty());
}

#[test]
fn an_identical_timestamp_is_not_outdated() {
    let r = vec![remote("FR/paris.bin", "2026-02-01T00:00:00Z")];
    assert!(outdated(&r, &[local("paris", "2026-02-01T00:00:00Z")]).is_empty());
}

#[test]
fn sub_second_ticks_decide_freshness() {
    let r = vec![remote("FR/paris.bin", "2026-02-01T00:00:00.0000002Z")];
    assert_eq!(outdated(&r, &[local("paris", "2026-02-01T00:00:00.0000001Z")]).len(), 1);
    assert!(outdated(&r, &[local("paris", "2026-02-01T00:00:00.0000003Z")]).is_empty());
}

#[test]
fn matching_ignores_the_key_prefix_and_one_extension() {
    // Local metadata records the key stem, which is what `download_file` names the file after.
    let r = vec![remote("FR/paris.bin", "2026-01-01T00:00:00Z")];
    assert!(outdated(&r, &[local("paris", "2026-06-01T00:00:00Z")]).is_empty());
    assert!(outdated(&r, &[local("paris.bin", "2026-06-01T00:00:00Z")]).is_empty());
    assert_eq!(outdated(&r, &[local("lyon", "2026-06-01T00:00:00Z")]).len(), 1);
}

#[test]
fn only_countries_holding_data_files_are_scanned() {
    let dir = std::env::temp_dir().join(format!("vali-stale-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(dir.join("FR")).unwrap();
    std::fs::create_dir_all(dir.join("DE")).unwrap();
    std::fs::create_dir_all(dir.join("not-a-country")).unwrap();
    std::fs::write(dir.join("FR").join("paris.bin"), b"x").unwrap();
    std::fs::write(dir.join("DE").join("downloads.json"), b"{}").unwrap();
    std::fs::write(dir.join("not-a-country").join("x.bin"), b"x").unwrap();

    // DE has metadata but no data file; the stray folder is not in Vali's country list.
    assert_eq!(downloaded_country_codes(&dir), vec!["FR".to_string()]);
    let _ = std::fs::remove_dir_all(&dir);
}
