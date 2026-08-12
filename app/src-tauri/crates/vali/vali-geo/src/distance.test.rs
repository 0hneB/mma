use super::*;

#[test]
fn detects_close_pair_across_antimeridian() {
    // ~222m apart across the seam; unwrapped dlon would read as ~360 degrees.
    assert!(points_are_closer_than(0.0, 179.999, 0.0, -179.999, 300.0 * 300.0));
    assert!(!points_are_closer_than(0.0, 179.999, 0.0, -179.999, 150.0 * 150.0));
}

#[test]
fn plain_pair_thresholds() {
    // ~157m apart at 45N.
    assert!(points_are_closer_than(45.0, 10.0, 45.0, 10.002, 200.0 * 200.0));
    assert!(!points_are_closer_than(45.0, 10.0, 45.0, 10.002, 100.0 * 100.0));
}
