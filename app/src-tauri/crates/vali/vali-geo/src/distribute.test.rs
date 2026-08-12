use super::*;
use mma_geo::M_PER_DEG;

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

// ~111m apart across the antimeridian: one must be thinned at 150m spacing,
// both kept at 100m.
#[test]
fn place_spaced_thins_across_antimeridian() {
    let pts = vec![(0.0, 179.9995), (0.0, -179.9995)];
    assert_eq!(place_spaced(&pts, 10, 150, &[]).len(), 1);
    assert_eq!(place_spaced(&pts, 10, 100, &[]).len(), 2);
}
