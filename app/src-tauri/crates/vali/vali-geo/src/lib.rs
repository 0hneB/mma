pub mod bucketize;
pub mod distribute;
pub mod geohash;
pub use bucketize::{bucketize, nearby};
pub use distribute::{get_some, place_spaced, with_max_min_distance, DISTANCES};
pub use geohash::{bounding_box, encode, neighbors, BoundingBox, HashPrecision};
pub use mma_geo::within_m2;
/// Kept for vali-generate's call sites; use `within_m2`.
pub use mma_geo::within_m2 as points_are_closer_than;
