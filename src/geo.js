// Great-circle distance between two points in degrees, in statute miles.
// This is straight-line distance; road distance is typically 15–30% longer.
const EARTH_RADIUS_MI = 3958.8;
const rad = (d) => (d * Math.PI) / 180;

function haversineMiles(a, b) {
  const dLat = rad(b.latitude - a.latitude);
  const dLon = rad(b.longitude - a.longitude);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.latitude)) * Math.cos(rad(b.latitude)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_MI * Math.asin(Math.min(1, Math.sqrt(h)));
}

module.exports = { haversineMiles };
