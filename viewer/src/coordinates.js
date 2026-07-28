export function normalizeRa(raDeg) {
    return ((raDeg % 360) + 360) % 360;
}
export function clampDec(decDeg) {
    return Math.max(-89.9, Math.min(89.9, decDeg));
}
export function raDecToCartesian(raDeg, decDeg, radius = 1) {
    const ra = (normalizeRa(raDeg) * Math.PI) / 180;
    const dec = (decDeg * Math.PI) / 180;
    const cosDec = Math.cos(dec);
    return {
        x: -radius * cosDec * Math.sin(ra),
        y: radius * Math.sin(dec),
        z: -radius * cosDec * Math.cos(ra),
    };
}
/** Convert the shared Three.js celestial frame back to ICRS coordinates. */
export function cartesianToRaDec(coordinate) {
    const radius = Math.hypot(coordinate.x, coordinate.y, coordinate.z);
    if (radius === 0)
        return { raDeg: 0, decDeg: 0 };
    return {
        raDeg: normalizeRa((Math.atan2(-coordinate.x, -coordinate.z) * 180) / Math.PI),
        decDeg: (Math.asin(Math.max(-1, Math.min(1, coordinate.y / radius))) * 180) / Math.PI,
    };
}
export function circularMidpoint(startDeg, spanDeg) {
    return normalizeRa(startDeg + spanDeg / 2);
}
