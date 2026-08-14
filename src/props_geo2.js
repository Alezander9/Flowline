/* ------------------------------------------------- built props */
const BOXG = new THREE.BoxGeometry(1, 1, 1);
function box(w, h, d, x, y, z, col, rotY) {
  const g = BOXG.clone().scale(w, h, d);
  if (rotY) g.rotateY(rotY);
  g.translate(x, y, z);
  return geoColor(g, typeof col === 'function' ? col : flat(col));
}
