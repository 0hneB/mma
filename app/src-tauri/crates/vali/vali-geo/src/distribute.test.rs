use super::*;

const M_PER_DEG: f64 = 6371137.0 * std::f64::consts::PI / 180.0;

// Above the old 89-degree cos_ref clamp, longitude cells were undersized and the
// 3x3 walk missed within-distance pairs, keeping both.
#[test]
fn place_spaced_thins_lng_pairs_above_89n() {
    let dlng = 90.0 / (M_PER_DEG * 89.9f64.to_radians().cos());
    let pts = vec![(89.9, 0.0), (89.9, dlng)];
    assert_eq!(place_spaced(&pts, 10, 100, &[]).len(), 1);
}

#[test]
fn place_spaced_keeps_spaced_lng_pairs_above_89n() {
    let dlng = 200.0 / (M_PER_DEG * 89.9f64.to_radians().cos());
    let pts = vec![(89.9, 0.0), (89.9, dlng)];
    assert_eq!(place_spaced(&pts, 10, 100, &[]).len(), 2);
}
