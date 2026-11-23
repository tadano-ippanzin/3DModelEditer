import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { OBJExporter } from 'three/addons/exporters/OBJExporter.js';
import { STLExporter } from 'three/addons/exporters/STLExporter.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

// === 1. シーン・カメラ・レンダラー・環境初期化 ===
const container = document.getElementById('canvas-container');
const scene = new THREE.Scene();
let bgHex = '#111318';
scene.background = new THREE.Color(bgHex);

const perspCam = new THREE.PerspectiveCamera(75, innerWidth / innerHeight, 0.1, 1000);
perspCam.position.set(5, 5, 5);
const orthoCam = new THREE.OrthographicCamera(-5, 5, 5, -5, 0.1, 1000);
orthoCam.position.copy(perspCam.position);
let activeCam = perspCam, isOrtho = false;

const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
renderer.setSize(innerWidth, innerHeight);
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
container.appendChild(renderer.domElement);

const ambientLight = new THREE.AmbientLight(0xffffff, 0.65);
const hemiLight = new THREE.HemisphereLight(0xdbeafe, 0x334155, 0.45);
const dirLight = new THREE.DirectionalLight(0xffffff, 1.2);
dirLight.position.set(6, 12, 8);
dirLight.castShadow = true;
dirLight.shadow.mapSize.set(2048, 2048);
Object.assign(dirLight.shadow.camera, { near: 0.5, far: 50, left: -12, right: 12, top: 12, bottom: -12 });
scene.add(ambientLight, hemiLight, dirLight);

let gridHelper = new THREE.GridHelper(20, 20, 0x4b5563, 0x222631);
const axesHelper = new THREE.AxesHelper(6);
axesHelper.visible = false;
const shadowFloor = new THREE.Mesh(new THREE.PlaneGeometry(60, 60), new THREE.ShadowMaterial({ opacity: 0.35 }));
shadowFloor.rotation.x = -Math.PI / 2;
shadowFloor.receiveShadow = true;
const boxHelper = new THREE.BoxHelper(new THREE.Object3D(), 0x00e588);
boxHelper.visible = false;
const editorRoot = new THREE.Group();
editorRoot.name = '__EDITOR_ROOT__';
scene.add(gridHelper, axesHelper, shadowFloor, boxHelper, editorRoot);

// === 2. コントロール & 状態 ===
const orbit = new OrbitControls(activeCam, renderer.domElement);
orbit.enableDamping = true;
orbit.dampingFactor = 0.08;
const transform = new TransformControls(activeCam, renderer.domElement);
transform.setSize(2.0);
scene.add(transform);

let selected = [], clipboard = [], matClipboard = null, dragSnap = null;
let idSeq = 0, lastDragEnd = 0, historyIdx = -1, isRestoring = false;
let currentMode = 'translate', currentSpace = 'world';
let showBoxHelper = true, uniformScale = false, animPlaying = true, globalWireframe = false;
let turntable = false, turntableSpeed = 2.0, polySides = 6, geoSegments = 24;
const historyStack = [];

transform.addEventListener('dragging-changed', (e) => {
  orbit.enabled = !e.value;
  if (e.value) {
    const p = primary();
    dragSnap = {
      pPos: p?.position.clone(), pQuat: p?.quaternion.clone(), pSca: p?.scale.clone(),
      others: selected.slice(0, -1).map((o) => ({ obj: o, pos: o.position.clone(), quat: o.quaternion.clone(), sca: o.scale.clone() }))
    };
  } else {
    lastDragEnd = performance.now();
    if (dragSnap) pushHistory();
    dragSnap = null;
  }
});

transform.addEventListener('objectChange', () => {
  const p = primary();
  if (!p) return;
  if (uniformScale && currentMode === 'scale' && dragSnap) {
    const d = [Math.abs(p.scale.x - dragSnap.pSca.x), Math.abs(p.scale.y - dragSnap.pSca.y), Math.abs(p.scale.z - dragSnap.pSca.z)];
    p.scale.setScalar(p.scale.toArray()[d.indexOf(Math.max(...d))]);
  }
  if (dragSnap && dragSnap.others.length) {
    const dPos = p.position.clone().sub(dragSnap.pPos);
    const dQuat = p.quaternion.clone().multiply(dragSnap.pQuat.clone().invert());
    const r = [0, 1, 2].map((i) => {
      const base = dragSnap.pSca.getComponent(i);
      return base ? p.scale.getComponent(i) / base : 1;
    });
    for (const it of dragSnap.others) {
      if (currentMode === 'translate') it.obj.position.copy(it.pos).add(dPos);
      if (currentMode === 'rotate') it.obj.quaternion.copy(dQuat).multiply(it.quat);
      if (currentMode === 'scale') it.obj.scale.set(it.sca.x * r[0], it.sca.y * r[1], it.sca.z * r[2]);
    }
  }
  syncInspector();
});

// === 3. 共通ユーティリティ ===
const toastEl = document.getElementById('toast');
let toastTimer = null;
const toast = (msg) => {
  toastEl.textContent = msg;
  toastEl.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('show'), 2100);
};
const primary = () => (selected.length ? selected[selected.length - 1] : null);
const getAllObjects = (root = editorRoot, list = []) => {
  for (const ch of root.children) {
    list.push(ch);
    if (ch.isGroup && ch.userData.kind === 'group') getAllObjects(ch, list);
  }
  return list;
};
const getEditableMeshes = (obj, list = []) => {
  if (!obj) return list;
  obj.traverse((c) => { if (c.isMesh && !c.userData.isLightProxy) list.push(c); });
  return list;
};
const disposeObjectTree = (obj) => obj.traverse((c) => {
  c.geometry?.dispose();
  if (c.material) (Array.isArray(c.material) ? c.material : [c.material]).forEach((m) => { m.map?.dispose(); m.dispose(); });
});
const removeAndDispose = (obj) => { obj.parent?.remove(obj); disposeObjectTree(obj); };
const downloadBlob = (blob, name) => {
  const a = document.createElement('a'), url = URL.createObjectURL(blob);
  a.href = url; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};
const setMaterialOpacity = (m, op) => {
  m.opacity = op;
  const tr = op < 0.999;
  if (m.transparent !== tr) { m.transparent = tr; m.needsUpdate = true; }
};

// === 4. 図形生成 & 選択(Raycaster) ===
function createMat(opts = {}) {
  const op = opts.opacity ?? 1.0;
  return new THREE.MeshStandardMaterial({
    color: opts.color ?? 0x00ff88, opacity: op, transparent: op < 0.999,
    metalness: opts.metalness ?? 0.1, roughness: opts.roughness ?? 0.55,
    emissive: new THREE.Color(opts.emissive ?? 0x000000), emissiveIntensity: opts.emissiveIntensity ?? 1.0,
    wireframe: opts.wireframe ?? globalWireframe, flatShading: !!opts.flatShading, side: opts.side ?? THREE.DoubleSide
  });
}

function makeGeometry(kind, params = {}) {
  const seg = params.seg ?? geoSegments, sides = params.sides ?? polySides;
  switch (kind) {
    case 'cube': return new THREE.BoxGeometry(1, 1, 1);
    case 'sphere': return new THREE.SphereGeometry(0.65, seg, Math.max(8, Math.floor(seg * 0.75)));
    case 'rod': return new THREE.CylinderGeometry(0.2, 0.2, 2, seg);
    case 'cone': return new THREE.ConeGeometry(0.65, 1.4, seg);
    case 'torus': return new THREE.TorusGeometry(0.6, 0.22, Math.max(8, Math.floor(seg / 2)), seg);
    case 'knot': return new THREE.TorusKnotGeometry(0.5, 0.16, seg * 3, Math.max(8, Math.floor(seg / 2)));
    case 'capsule': return new THREE.CapsuleGeometry(0.35, 0.8, 8, seg);
    case 'tetra': return new THREE.TetrahedronGeometry(0.75);
    case 'octa': return new THREE.OctahedronGeometry(0.75);
    case 'dodeca': return new THREE.DodecahedronGeometry(0.75);
    case 'icosa': return new THREE.IcosahedronGeometry(0.75);
    case 'plane': return new THREE.PlaneGeometry(1, 1);
    case 'circle': return new THREE.CircleGeometry(0.7, seg);
    case 'ring': return new THREE.RingGeometry(0.35, 0.75, seg);
    case 'poly': return new THREE.CircleGeometry(0.7, sides);
    case 'line': return new THREE.PlaneGeometry(0.05, 2);
    case 'helix': {
      const pts = Array.from({ length: 49 }, (_, i) => {
        const t = (i / 48) * Math.PI * 6;
        return new THREE.Vector3(Math.cos(t) * 0.5, (i / 48 - 0.5) * 1.8, Math.sin(t) * 0.5);
      });
      return new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 64, 0.08, 10, false);
    }
    default: return new THREE.BoxGeometry(1, 1, 1);
  }
}

const KIND_LABELS = {
  cube: '立方体', sphere: '球体', rod: '円柱', cone: '円錐', torus: 'トーラス', knot: '結び目',
  capsule: 'カプセル', tetra: '正4面体', octa: '正8面体', dodeca: '正12面体', icosa: '正20面体',
  plane: '四角板', circle: '円板', ring: 'リング', poly: '多角形', line: '線分板', helix: '螺旋',
  light: '点光源', group: 'グループ', custom: 'カスタム'
};

function addShape(kind, skipHistory = false) {
  let obj;
  if (kind === 'light') {
    obj = new THREE.Group();
    const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.2, 16, 12), new THREE.MeshBasicMaterial({ color: 0xffe066 }));
    bulb.userData.isLightProxy = true;
    const pt = new THREE.PointLight(0xffe066, 3.0, 20);
    pt.castShadow = true;
    obj.add(bulb, pt);
    obj.position.set(0, 2.5, 0);
  } else {
    const params = { seg: geoSegments, sides: polySides };
    obj = new THREE.Mesh(makeGeometry(kind, params), createMat());
    obj.castShadow = obj.receiveShadow = true;
    obj.userData.params = params;
  }
  obj.name = `${KIND_LABELS[kind] || kind}_${++idSeq}`;
  Object.assign(obj.userData, { id: `obj_${idSeq}_${Date.now()}`, kind, locked: false, texPreset: 'none', texRepeat: [1, 1], anim: { type: 'none', speed: 1 } });
  editorRoot.add(obj);
  setSelection([obj]);
  if (!skipHistory) pushHistory();
  toast(`${obj.name} を追加しました`);
  return obj;
}

function updateSelectionBox() {
  const p = primary();
  if (p && showBoxHelper) {
    p.updateMatrixWorld(true);
    if (!new THREE.Box3().setFromObject(p).isEmpty()) { boxHelper.setFromObject(p); boxHelper.visible = true; return; }
  }
  boxHelper.visible = false;
}

function setSelection(objs) {
  selected = objs.filter((o) => o && !o.userData.locked);
  const p = primary();
  if (p) transform.attach(p); else transform.detach();
  updateSelectionBox(); updateOutliner(); syncInspector(); updateStats();
}

const raycaster = new THREE.Raycaster(), ptrDown = { x: 0, y: 0 };
renderer.domElement.addEventListener('pointerdown', (e) => { ptrDown.x = e.clientX; ptrDown.y = e.clientY; });
renderer.domElement.addEventListener('pointerup', (e) => {
  if (e.button !== 0 || transform.dragging || transform.axis || performance.now() - lastDragEnd < 120) return;
  if (Math.hypot(e.clientX - ptrDown.x, e.clientY - ptrDown.y) > 6) return;
  const r = renderer.domElement.getBoundingClientRect();
  raycaster.setFromCamera(new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), activeCam);
  const hits = raycaster.intersectObjects(editorRoot.children, true);
  if (!hits.length) { if (!e.shiftKey) setSelection([]); return; }
  let t = hits[0].object;
  if (t.userData.isLightProxy && t.parent) t = t.parent;
  while (t.parent && t.parent !== editorRoot && t.parent.userData.kind === 'group') {
    if (t.parent.userData.locked) return;
    t = t.parent;
  }
  if (t.userData.locked) return toast('ロック中です');
  setSelection(e.shiftKey ? (selected.includes(t) ? selected.filter((x) => x !== t) : [...selected, t]) : [t]);
});

// === 5. 編集・複製・グループ・配列・モデリング ===
function deleteSelected() {
  if (!selected.length) return;
  const targets = [...selected];
  setSelection([]);
  targets.forEach(removeAndDispose);
  pushHistory(); updateOutliner(); updateStats();
  toast(`${targets.length}個を削除しました`);
}

function cloneObjectDeep(src) {
  const c = src.clone();
  c.traverse((n) => {
    n.userData = JSON.parse(JSON.stringify(n.userData || {}));
    delete n.userData._bobY; delete n.userData._pulseF;
    if (n.isMesh) { n.geometry = n.geometry.clone(); n.material = n.material.clone(); }
  });
  c.userData.id = `obj_${++idSeq}_${Date.now()}`;
  c.name = `${src.name}_copy`;
  return c;
}

function duplicateSelected(offset = 0.6) {
  if (!selected.length) return toast('対象を選択してください');
  const created = selected.map((s) => { const c = cloneObjectDeep(s); c.position.x += offset; (s.parent || editorRoot).add(c); return c; });
  setSelection(created); pushHistory(); toast(`${created.length}個を複製しました`);
}
function copySelected() {
  if (!selected.length) return;
  clipboard = selected.map(serializeObject);
  toast(`${clipboard.length}個をコピーしました`);
}
function pasteClipboard() {
  if (!clipboard.length) return toast('クリップボードが空です');
  const created = clipboard.map((d) => {
    const o = deserializeObject(d);
    o.position.x += 0.8; o.userData.id = `obj_${++idSeq}_${Date.now()}`; o.name += '_paste';
    editorRoot.add(o); return o;
  });
  setSelection(created); pushHistory(); toast(`${created.length}個を貼り付けました`);
}
function groupSelected() {
  if (selected.length < 2) return toast('2つ以上選択してください');
  const center = new THREE.Vector3();
  selected.forEach((o) => center.add(o.getWorldPosition(new THREE.Vector3())));
  center.divideScalar(selected.length);
  const grp = new THREE.Group();
  grp.name = `グループ_${++idSeq}`;
  grp.userData = { id: `obj_${idSeq}_${Date.now()}`, kind: 'group', locked: false, anim: { type: 'none', speed: 1 } };
  grp.position.copy(center);
  editorRoot.add(grp);
  selected.forEach((o) => grp.attach(o));
  setSelection([grp]); pushHistory(); toast('グループ化しました');
}
function ungroupSelected() {
  const p = primary();
  if (!p || p.userData.kind !== 'group') return toast('グループを選択してください');
  const ch = [...p.children];
  ch.forEach((c) => editorRoot.attach(c));
  p.parent?.remove(p);
  setSelection(ch); pushHistory(); toast('グループ解除しました');
}
function dropToFloor() {
  if (!selected.length) return;
  selected.forEach((o) => { o.updateMatrixWorld(true); const b = new THREE.Box3().setFromObject(o); if (!b.isEmpty()) o.position.y -= b.min.y; });
  syncInspector(); pushHistory(); toast('地面(Y=0)に接地しました');
}
function centerXZ() {
  if (!selected.length) return;
  selected.forEach((o) => { o.updateMatrixWorld(true); const b = new THREE.Box3().setFromObject(o); if (!b.isEmpty()) { const c = b.getCenter(new THREE.Vector3()); o.position.x -= c.x; o.position.z -= c.z; } });
  syncInspector(); pushHistory(); toast('XZ原点へ揃えました');
}
function mirrorDuplicate(axis) {
  if (!selected.length) return toast('対象を選択してください');
  const created = selected.map((s) => { const c = cloneObjectDeep(s); c.position[axis] *= -1; c.scale[axis] *= -1; c.name = `${s.name}_mir${axis.toUpperCase()}`; (s.parent || editorRoot).add(c); return c; });
  setSelection(created); pushHistory(); toast(`${axis.toUpperCase()}軸でミラー複製しました`);
}
function linearArray(axis, count, step) {
  const p = primary(); if (!p) return toast('対象を選択してください');
  const created = Array.from({ length: count - 1 }, (_, i) => { const c = cloneObjectDeep(p); c.position[axis] += step * (i + 1); (p.parent || editorRoot).add(c); return c; });
  setSelection([p, ...created]); pushHistory(); toast(`${axis.toUpperCase()}軸に${count}個配列しました`);
}
function circularArray(count, radius) {
  const p = primary(); if (!p) return toast('対象を選択してください');
  const ctr = p.position.clone();
  const created = Array.from({ length: count }, (_, i) => {
    const a = (i / count) * Math.PI * 2, c = cloneObjectDeep(p);
    c.position.set(ctr.x + Math.cos(a) * radius, ctr.y, ctr.z + Math.sin(a) * radius);
    c.rotation.y = -a; editorRoot.add(c); return c;
  });
  setSelection(created); pushHistory(); toast(`${count}個を円形配置しました`);
}
function scatterObjects(count, spread) {
  const p = primary(); if (!p) return toast('対象を選択してください');
  const created = Array.from({ length: count }, () => {
    const c = cloneObjectDeep(p);
    c.position.set((Math.random() - 0.5) * spread * 2, p.position.y, (Math.random() - 0.5) * spread * 2);
    c.rotation.y = Math.random() * Math.PI * 2; c.scale.multiplyScalar(0.5 + Math.random() * 1.1);
    editorRoot.add(c); return c;
  });
  setSelection(created); pushHistory(); toast(`${count}個を散布しました`);
}

function mergeSelectedMeshes() {
  const meshes = selected.flatMap((o) => getEditableMeshes(o));
  if (meshes.length < 2) return toast('2つ以上のメッシュを選択してください');
  const geoms = meshes.map((m) => {
    m.updateWorldMatrix(true, false);
    let g = m.geometry.clone(); g.applyMatrix4(m.matrixWorld);
    if (g.index) g = g.toNonIndexed();
    if (!g.attributes.normal) g.computeVertexNormals();
    if (!g.attributes.uv) g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(g.attributes.position.count * 2), 2));
    for (const k of Object.keys(g.attributes)) if (!['position', 'normal', 'uv'].includes(k)) g.deleteAttribute(k);
    return g;
  });
  const merged = mergeGeometries(geoms, false);
  geoms.forEach((g) => g.dispose());
  if (!merged) return toast('結合に失敗しました');
  merged.computeBoundingBox();
  const center = merged.boundingBox.getCenter(new THREE.Vector3());
  merged.translate(-center.x, -center.y, -center.z);
  const mesh = new THREE.Mesh(merged, meshes[meshes.length - 1].material.clone());
  mesh.position.copy(center); mesh.castShadow = mesh.receiveShadow = true;
  mesh.name = `結合モデル_${++idSeq}`;
  mesh.userData = { id: `obj_${idSeq}_${Date.now()}`, kind: 'custom', customGeo: true, locked: false, anim: { type: 'none', speed: 1 } };
  const old = [...selected]; setSelection([]); old.forEach(removeAndDispose);
  editorRoot.add(mesh); setSelection([mesh]); pushHistory(); toast('メッシュを結合しました');
}

function extrudeSelected2D(depth = 0.45) {
  const p = primary();
  if (!p || !p.isMesh) return toast('2D図形を選択してください');
  const k = p.userData.kind, shape = new THREE.Shape();
  if (k === 'plane' || k === 'line') {
    const w = k === 'line' ? 0.05 : 1, h = k === 'line' ? 2 : 1;
    shape.moveTo(-w / 2, -h / 2); shape.lineTo(w / 2, -h / 2); shape.lineTo(w / 2, h / 2); shape.lineTo(-w / 2, h / 2); shape.closePath();
  } else if (k === 'circle' || k === 'poly') {
    const sides = k === 'poly' ? (p.userData.params?.sides ?? 6) : 32;
    for (let i = 0; i < sides; i++) { const a = (i / sides) * Math.PI * 2; i === 0 ? shape.moveTo(Math.cos(a) * 0.7, Math.sin(a) * 0.7) : shape.lineTo(Math.cos(a) * 0.7, Math.sin(a) * 0.7); }
    shape.closePath();
  } else if (k === 'ring') {
    shape.absarc(0, 0, 0.75, 0, Math.PI * 2, false);
    const hole = new THREE.Path(); hole.absarc(0, 0, 0.35, 0, Math.PI * 2, true); shape.holes.push(hole);
  } else return toast('四角・円・リング・多角形・線に対応しています');
  const geo = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: true, bevelThickness: 0.02, bevelSize: 0.02, bevelSegments: 2 });
  geo.center(); p.geometry.dispose(); p.geometry = geo;
  p.userData.kind = 'custom'; p.userData.customGeo = true;
  pushHistory(); updateStats(); toast('立体へ押し出しました');
}

function deformVertices(mode, str = 0.25) {
  const meshes = selected.flatMap((o) => getEditableMeshes(o));
  if (!meshes.length) return toast('メッシュを選択してください');
  for (const m of meshes) {
    const g = m.geometry, pos = g.attributes.position, map = new Map();
    for (let i = 0; i < pos.count; i++) {
      let x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
      if (mode === 'jitter') {
        const key = `${x.toFixed(3)}_${y.toFixed(3)}_${z.toFixed(3)}`;
        if (!map.has(key)) map.set(key, [(Math.random() - 0.5) * str, (Math.random() - 0.5) * str, (Math.random() - 0.5) * str]);
        const [dx, dy, dz] = map.get(key); x += dx; y += dy; z += dz;
      } else if (mode === 'twist') {
        const a = y * str * 2.5, c = Math.cos(a), s = Math.sin(a);
        [x, z] = [x * c - z * s, x * s + z * c];
      } else if (mode === 'taper') {
        const f = Math.max(0.15, 1 + y * str * 1.5); x *= f; z *= f;
      } else if (mode === 'bulge') {
        const f = 1 + str * 0.4 * Math.exp(-(Math.hypot(x, y, z) || 1)); x *= f; y *= f; z *= f;
      }
      pos.setXYZ(i, x, y, z);
    }
    pos.needsUpdate = true; g.computeVertexNormals(); g.computeBoundingBox(); g.computeBoundingSphere();
    m.userData.customGeo = true;
  }
  pushHistory(); toast(`${mode} 変形を適用しました`);
}

function setShadingMode(flat) {
  const meshes = selected.flatMap((o) => getEditableMeshes(o));
  if (!meshes.length) return;
  meshes.forEach((m) => { m.material.flatShading = flat; m.material.needsUpdate = true; if (!flat) m.geometry.computeVertexNormals(); });
  syncInspector(); pushHistory(); toast(flat ? 'フラットシェード' : 'スムースシェード');
}

// === 6. マテリアル & テクスチャ ===
function makePresetTexture(type, repeat = [1, 1]) {
  if (type === 'none') return null;
  const cvs = document.createElement('canvas'); cvs.width = cvs.height = 256;
  const ctx = cvs.getContext('2d');
  if (type === 'checker') {
    for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
      ctx.fillStyle = (x + y) % 2 === 0 ? '#fff' : '#334155'; ctx.fillRect(x * 32, y * 32, 32, 32);
    }
  } else if (type === 'stripe') {
    for (let i = 0; i < 16; i++) { ctx.fillStyle = i % 2 === 0 ? '#fff' : '#475569'; ctx.fillRect(i * 16, 0, 16, 256); }
  } else if (type === 'grad') {
    const grd = ctx.createLinearGradient(0, 0, 256, 256);
    grd.addColorStop(0, '#00e588'); grd.addColorStop(0.5, '#3b82f6'); grd.addColorStop(1, '#ec4899');
    ctx.fillStyle = grd; ctx.fillRect(0, 0, 256, 256);
  } else if (type === 'noise') {
    const img = ctx.createImageData(256, 256);
    for (let i = 0; i < img.data.length; i += 4) { const v = 130 + Math.floor(Math.random() * 110); img.data[i] = img.data[i + 1] = img.data[i + 2] = v; img.data[i + 3] = 255; }
    ctx.putImageData(img, 0, 0);
  }
  const tex = new THREE.CanvasTexture(cvs);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping; tex.repeat.set(repeat[0], repeat[1]); tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function applyColorHex(val, preserveAlpha = false) {
  const clean = String(val).trim().replace('#', '');
  if (![3, 4, 6, 8].includes(clean.length) || !/^[0-9a-fA-F]+$/.test(clean)) return;
  let rgb = clean, alpha = null;
  if (clean.length === 4) { rgb = clean[0] + clean[0] + clean[1] + clean[1] + clean[2] + clean[2]; alpha = parseInt(clean[3] + clean[3], 16) / 255; }
  else if (clean.length === 8) { rgb = clean.slice(0, 6); alpha = parseInt(clean.slice(6, 8), 16) / 255; }
  for (const o of selected) {
    if (o.userData.kind === 'light') {
      o.children.forEach((c) => {
        if (c.isLight) c.color.set('#' + rgb);
        if (c.isMesh) c.material.color.set('#' + rgb);
      });
    }
    for (const m of getEditableMeshes(o)) {
      m.material.color.set('#' + rgb);
      if (alpha !== null) setMaterialOpacity(m.material, alpha);
      else if (!preserveAlpha) setMaterialOpacity(m.material, 1.0);
    }
  }
  syncInspector();
}

function applyMaterialPreset(preset) {
  const cfg = {
    standard: { metalness: 0.1, roughness: 0.55, opacity: 1.0, emissive: '#000000', emissiveIntensity: 0 },
    matte: { metalness: 0.0, roughness: 0.95, opacity: 1.0, emissive: '#000000', emissiveIntensity: 0 },
    metal: { metalness: 0.92, roughness: 0.18, opacity: 1.0, emissive: '#000000', emissiveIntensity: 0 },
    glass: { metalness: 0.05, roughness: 0.08, opacity: 0.38, emissive: '#000000', emissiveIntensity: 0 },
    neon: { metalness: 0.1, roughness: 0.3, opacity: 1.0, emissive: null, emissiveIntensity: 1.8 }
  }[preset];
  if (!cfg) return;
  for (const o of selected) for (const m of getEditableMeshes(o)) {
    m.material.metalness = cfg.metalness; m.material.roughness = cfg.roughness;
    setMaterialOpacity(m.material, cfg.opacity);
    if (m.material.emissive) {
      m.material.emissive.copy(cfg.emissive === null ? m.material.color : new THREE.Color(cfg.emissive));
      m.material.emissiveIntensity = cfg.emissiveIntensity;
    }
  }
  syncInspector(); pushHistory(); toast(`プリセット「${preset}」適用`);
}

// === 7. カメラ & 投影 ===
function updateOrthoFrustum() {
  if (!isOrtho) return;
  const aspect = innerWidth / innerHeight, dist = activeCam.position.distanceTo(orbit.target);
  const halfH = dist * Math.tan(THREE.MathUtils.degToRad(perspCam.fov / 2));
  Object.assign(orthoCam, { left: -halfH * aspect, right: halfH * aspect, top: halfH, bottom: -halfH });
  orthoCam.updateProjectionMatrix();
}
function focusObject(obj = primary()) {
  const box = new THREE.Box3().setFromObject(obj || editorRoot);
  if (box.isEmpty()) { orbit.target.set(0, 0, 0); activeCam.position.set(5, 5, 5); updateOrthoFrustum(); orbit.update(); return; }
  const center = box.getCenter(new THREE.Vector3()), size = box.getSize(new THREE.Vector3()).length() || 2;
  const dir = activeCam.position.clone().sub(orbit.target).normalize();
  orbit.target.copy(center); activeCam.position.copy(center).addScaledVector(dir, Math.max(2.5, size * 1.4));
  updateOrthoFrustum(); orbit.update();
}
function setCameraView(view) {
  const t = orbit.target.clone(), dist = Math.max(4, activeCam.position.distanceTo(t));
  const map = { front: [0, 0, 1], back: [0, 0, -1], right: [1, 0, 0], left: [-1, 0, 0], top: [0, 1, 0.001], bottom: [0, -1, 0.001], iso: [1, 1, 1] };
  activeCam.position.copy(t).addScaledVector(new THREE.Vector3(...(map[view] || [1, 1, 1])).normalize(), dist);
  activeCam.lookAt(t); updateOrthoFrustum(); orbit.update(); toast(`視点: ${view}`);
}
function toggleProjection() {
  isOrtho = !isOrtho;
  const next = isOrtho ? orthoCam : perspCam;
  next.position.copy(activeCam.position); next.quaternion.copy(activeCam.quaternion);
  activeCam = next; if (isOrtho) updateOrthoFrustum();
  orbit.object = activeCam; transform.camera = activeCam; orbit.update();
  toast(isOrtho ? '平行投影 (Ortho)' : '透視投影 (Persp)');
}

// === 8. シリアライズ & Undo/Redo & エクスポート ===
const resetAnimOffsets = (obj) => {
  if (obj.userData._bobY) { obj.position.y -= obj.userData._bobY; obj.userData._bobY = 0; }
  if (obj.userData._pulseF && obj.userData._pulseF !== 1) { obj.scale.divideScalar(obj.userData._pulseF); obj.userData._pulseF = 1; }
};

function serializeObject(obj) {
  const pos = obj.position.toArray(), sca = obj.scale.toArray();
  if (obj.userData._bobY) pos[1] -= obj.userData._bobY;
  if (obj.userData._pulseF && obj.userData._pulseF !== 1) for (let i = 0; i < 3; i++) sca[i] /= obj.userData._pulseF;
  const base = {
    id: obj.userData.id, name: obj.name, kind: obj.userData.kind || 'cube', params: obj.userData.params || {},
    locked: !!obj.userData.locked, visible: obj.visible, pos, rot: [obj.rotation.x, obj.rotation.y, obj.rotation.z], sca,
    anim: obj.userData.anim || { type: 'none', speed: 1 }
  };
  if (obj.userData.kind === 'light') {
    const pt = obj.children.find((c) => c.isLight);
    base.lightColor = pt ? pt.color.getHex() : 0xffe066; base.lightIntensity = pt ? pt.intensity : 3;
    return base;
  }
  if (obj.isGroup) { base.children = obj.children.map(serializeObject); return base; }
  if (obj.isMesh) {
    const m = obj.material;
    base.mat = {
      color: m.color.getHex(), opacity: m.opacity, metalness: m.metalness ?? 0.1, roughness: m.roughness ?? 0.55,
      emissive: m.emissive ? m.emissive.getHex() : 0, emissiveIntensity: m.emissiveIntensity ?? 1,
      wireframe: !!m.wireframe, flatShading: !!m.flatShading, side: m.side,
      texPreset: obj.userData.texPreset || 'none', texDataUrl: obj.userData.texDataUrl || null, texRepeat: obj.userData.texRepeat || [1, 1]
    };
    if (obj.userData.customGeo) {
      const g = obj.geometry;
      base.customGeo = {
        pos: Array.from(g.attributes.position.array),
        norm: g.attributes.normal ? Array.from(g.attributes.normal.array) : null,
        uv: g.attributes.uv ? Array.from(g.attributes.uv.array) : null,
        idx: g.index ? Array.from(g.index.array) : null
      };
    }
  }
  return base;
}

function deserializeObject(d) {
  let obj;
  if (d.type && !d.kind) {
    let geo; const t = d.type;
    if (t.includes('Box')) geo = new THREE.BoxGeometry(1, 1, 1);
    else if (t.includes('Sphere')) geo = new THREE.SphereGeometry(0.7, 32, 32);
    else if (t.includes('Cylinder')) geo = new THREE.CylinderGeometry(0.2, 0.2, 2, 32);
    else if (t.includes('Plane')) geo = new THREE.PlaneGeometry(d.parameters?.width ?? 1, d.parameters?.height ?? 1);
    else if (t.includes('Circle')) geo = new THREE.CircleGeometry(0.7, d.parameters?.segments ?? 32);
    else geo = new THREE.BoxGeometry(1, 1, 1);
    obj = new THREE.Mesh(geo, createMat({ color: d.col ?? 0x00ff88, opacity: d.op ?? 1 }));
    obj.castShadow = obj.receiveShadow = true; obj.name = `${t}_${++idSeq}`;
    obj.userData = { id: `obj_${idSeq}`, kind: 'custom', customGeo: true, locked: false, anim: { type: 'none', speed: 1 } };
  } else if (d.kind === 'light') {
    obj = new THREE.Group(); const col = d.lightColor ?? 0xffe066;
    const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.2, 16, 12), new THREE.MeshBasicMaterial({ color: col }));
    bulb.userData.isLightProxy = true;
    const pt = new THREE.PointLight(col, d.lightIntensity ?? 3, 20); pt.castShadow = true;
    obj.add(bulb, pt);
  } else if (d.children) {
    obj = new THREE.Group(); d.children.forEach((ch) => obj.add(deserializeObject(ch)));
  } else {
    let geo;
    if (d.customGeo) {
      geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(d.customGeo.pos, 3));
      if (d.customGeo.norm) geo.setAttribute('normal', new THREE.Float32BufferAttribute(d.customGeo.norm, 3));
      if (d.customGeo.uv) geo.setAttribute('uv', new THREE.Float32BufferAttribute(d.customGeo.uv, 2));
      if (d.customGeo.idx) geo.setIndex(d.customGeo.idx);
      if (!d.customGeo.norm) geo.computeVertexNormals();
    } else geo = makeGeometry(d.kind, d.params || {});
    const mat = createMat(d.mat || {});
    if (d.mat?.texDataUrl) {
      const img = new Image();
      img.onload = () => {
        const tex = new THREE.Texture(img);
        tex.wrapS = tex.wrapT = THREE.RepeatWrapping; tex.repeat.set(...(d.mat.texRepeat || [1, 1]));
        tex.colorSpace = THREE.SRGBColorSpace; tex.needsUpdate = true; mat.map = tex; mat.needsUpdate = true;
      };
      img.src = d.mat.texDataUrl;
    } else if (d.mat?.texPreset && d.mat.texPreset !== 'none') mat.map = makePresetTexture(d.mat.texPreset, d.mat.texRepeat || [1, 1]);
    obj = new THREE.Mesh(geo, mat); obj.castShadow = obj.receiveShadow = true;
  }
  obj.name = d.name || `Obj_${++idSeq}`;
  Object.assign(obj.userData, {
    id: d.id || `obj_${idSeq}`, kind: d.kind || obj.userData.kind || 'custom', params: d.params || {},
    locked: !!d.locked, customGeo: !!d.customGeo, texPreset: d.mat?.texPreset || 'none',
    texDataUrl: d.mat?.texDataUrl || null, texRepeat: d.mat?.texRepeat || [1, 1], anim: d.anim || { type: 'none', speed: 1 }
  });
  if (d.visible !== undefined) obj.visible = d.visible;
  if (d.pos) obj.position.fromArray(d.pos);
  if (d.rot) obj.rotation.set(...d.rot);
  if (d.sca) obj.scale.fromArray(d.sca);
  return obj;
}

const serializeScene = () => ({
  version: 2,
  env: { bgHex, fogOn: !!scene.fog, fogColor: scene.fog ? '#' + scene.fog.color.getHexString() : bgHex, fogDensity: scene.fog?.density ?? 0.04 },
  objects: editorRoot.children.map(serializeObject)
});

function loadSerializedScene(data, append = false) {
  isRestoring = true;
  if (!append) { setSelection([]); while (editorRoot.children.length) removeAndDispose(editorRoot.children[0]); }
  (Array.isArray(data) ? data : (data.objects || [])).forEach((d) => editorRoot.add(deserializeObject(d)));
  if (!Array.isArray(data) && data.env && !append) {
    bgHex = data.env.bgHex || '#111318'; scene.background = new THREE.Color(bgHex);
    scene.fog = data.env.fogOn ? new THREE.FogExp2(data.env.fogColor || bgHex, data.env.fogDensity || 0.04) : null;
  }
  idSeq = Math.max(idSeq, getAllObjects().length);
  isRestoring = false;
  updateOutliner(); updateStats(); syncInspector();
}

function pushHistory() {
  if (isRestoring) return;
  const snap = JSON.stringify(serializeScene());
  if (historyStack[historyIdx] === snap) return;
  historyStack.splice(historyIdx + 1);
  historyStack.push(snap);
  if (historyStack.length > 30) historyStack.shift();
  historyIdx = historyStack.length - 1;
  try { localStorage.setItem('3875d_autosave', snap); } catch (_) {}
  updateStats();
}
function undo() { if (historyIdx <= 0) return toast('これ以上戻せません'); historyIdx--; loadSerializedScene(JSON.parse(historyStack[historyIdx])); toast('元に戻しました'); }
function redo() { if (historyIdx >= historyStack.length - 1) return toast('やり直す操作がありません'); historyIdx++; loadSerializedScene(JSON.parse(historyStack[historyIdx])); toast('やり直しました'); }

function exportModel(fmt) {
  if (!editorRoot.children.length) return toast('モデルがありません');
  if (fmt === 'json') { downloadBlob(new Blob([JSON.stringify(serializeScene(), null, 2)], { type: 'application/json' }), 'scene.json'); return toast('JSON を書き出しました'); }
  const detached = [];
  editorRoot.traverse((c) => { if (c.userData.isLightProxy && c.parent) detached.push([c, c.parent]); });
  detached.forEach(([c, p]) => p.remove(c));
  const restore = () => detached.forEach(([c, p]) => p.add(c));
  if (fmt === 'glb' || fmt === 'gltf') {
    new GLTFExporter().parse(editorRoot, (res) => {
      restore();
      downloadBlob(res instanceof ArrayBuffer ? new Blob([res], { type: 'model/gltf-binary' }) : new Blob([JSON.stringify(res, null, 2)], { type: 'application/json' }), `model.${fmt}`);
      toast(`${fmt.toUpperCase()} を書き出しました`);
    }, () => { restore(); toast('書き出しエラー'); }, { binary: fmt === 'glb' });
  } else if (fmt === 'obj') {
    try { downloadBlob(new Blob([new OBJExporter().parse(editorRoot)], { type: 'text/plain' }), 'model.obj'); toast('OBJ を書き出しました'); } finally { restore(); }
  } else if (fmt === 'stl') {
    try { downloadBlob(new Blob([new STLExporter().parse(editorRoot, { binary: true })], { type: 'application/octet-stream' }), 'model.stl'); toast('STL を書き出しました'); } finally { restore(); }
  }
}

function importExternalModel(file) {
  const ext = file.name.split('.').pop().toLowerCase(), reader = new FileReader();
  const wrap = (obj3d) => {
    const grp = new THREE.Group(); grp.name = file.name;
    grp.userData = { id: `obj_${++idSeq}_${Date.now()}`, kind: 'group', locked: false, anim: { type: 'none', speed: 1 } };
    obj3d.traverse((c) => {
      if (c.isMesh) {
        c.castShadow = c.receiveShadow = true; c.userData.customGeo = true; c.userData.kind = 'custom';
        const m = Array.isArray(c.material) ? c.material[0] : c.material;
        if (!m || !m.isMeshStandardMaterial) { c.material = createMat({ color: m?.color ? m.color.getHex() : 0x00ff88, opacity: m?.opacity ?? 1 }); if (m?.map) c.material.map = m.map; }
      }
    });
    grp.add(obj3d); editorRoot.add(grp); setSelection([grp]); focusObject(grp); pushHistory();
    toast(`${file.name} を読み込みました`);
  };
  if (ext === 'obj') { reader.onload = (e) => wrap(new OBJLoader().parse(e.target.result)); reader.readAsText(file); }
  else if (ext === 'gltf') { reader.onload = (e) => new GLTFLoader().parse(e.target.result, '', (g) => wrap(g.scene), () => toast('読込エラー')); reader.readAsText(file); }
  else { reader.onload = (e) => new GLTFLoader().parse(e.target.result, '', (g) => wrap(g.scene), () => toast('読込エラー')); reader.readAsArrayBuffer(file); }
}

function takeScreenshot(transparentBg = false) {
  const [prevBg, prevGrid, prevTr, prevBox] = [scene.background, gridHelper.visible, transform.visible, boxHelper.visible];
  transform.visible = boxHelper.visible = false;
  if (transparentBg) { scene.background = null; gridHelper.visible = false; renderer.setClearAlpha(0); }
  renderer.render(scene, activeCam);
  renderer.domElement.toBlob((b) => {
    if (b) downloadBlob(b, 'render.png');
    scene.background = prevBg; gridHelper.visible = prevGrid; transform.visible = prevTr; boxHelper.visible = prevBox; renderer.setClearAlpha(1);
    toast('スクリーンショットを保存しました');
  });
}

// === 9. UIビルダー & タブ構築 ===
const el = (tag, props = {}, children = []) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') n.className = v;
    else if (k === 'text') n.textContent = v;
    else if (k === 'style') n.style.cssText = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2).toLowerCase(), v);
    else n[k] = v;
  }
  for (const ch of children) if (ch) n.appendChild(typeof ch === 'string' ? document.createTextNode(ch) : ch);
  return n;
};
const mkSec = (title, ch = []) => el('div', { class: 'sec' }, [el('div', { class: 'sec-title', text: title }), ...ch]);
const mkBtn = (text, onClick, cls = '') => el('button', { text, class: cls, onClick });
const mkRow = (label, ctrl) => el('div', { class: 'row' }, [el('label', { text: label }), ctrl]);
const mkRange = (min, max, step, value, onInput, onChange) => el('input', { type: 'range', min, max, step, value, onInput, ...(onChange ? { onChange } : {}) });
const mkChk = (checked, onChange) => el('input', { type: 'checkbox', checked, onChange });
const mkNum = (value, opts = {}, onChange) => el('input', { type: 'number', value, ...opts, ...(onChange ? { onChange } : {}) });

const tabBar = document.getElementById('tab-bar'), panelBody = document.getElementById('panel-body'), panes = {};
[['add', '追加'], ['tree', '構造'], ['edit', '変形'], ['mat', '質感'], ['env', '環境/IO']].forEach(([id, lbl], i) => {
  const b = mkBtn(lbl, () => {
    document.querySelectorAll('.tab-btn').forEach((x) => x.classList.remove('active'));
    Object.values(panes).forEach((p) => p.classList.remove('active'));
    b.classList.add('active'); panes[id].classList.add('active');
  }, i === 0 ? 'tab-btn active' : 'tab-btn');
  tabBar.appendChild(b);
  panes[id] = el('div', { class: i === 0 ? 'tab-pane active' : 'tab-pane' });
  panelBody.appendChild(panes[id]);
});

// タブ1: 追加
const arrAxis = el('select', {}, ['x', 'y', 'z'].map((a) => el('option', { value: a, text: a.toUpperCase() + '軸' })));
const arrCount = mkNum(4, { min: 2, max: 30 }), arrStep = mkNum(1.4, { step: 0.2 }), circRadius = mkNum(2.5, { step: 0.2 });
panes.add.append(
  mkSec('3D プリミティブ', [el('div', { class: 'grid-2' }, [['cube', '立方体'], ['sphere', '球体'], ['rod', '円柱/棒'], ['cone', '円錐'], ['torus', 'トーラス'], ['knot', '結び目'], ['capsule', 'カプセル'], ['helix', '螺旋']].map(([k, l]) => mkBtn(l, () => addShape(k))))]),
  mkSec('正多面体', [el('div', { class: 'grid-2' }, [['tetra', '正4面体'], ['octa', '正8面体'], ['dodeca', '正12面体'], ['icosa', '正20面体']].map(([k, l]) => mkBtn(l, () => addShape(k))))]),
  mkSec('2D 図形 & ライト', [
    el('div', { class: 'grid-3' }, [['plane', '四角板'], ['circle', '円板'], ['ring', 'リング'], ['poly', 'N角形'], ['line', '線分板'], ['light', '点光源']].map(([k, l]) => mkBtn(l, () => addShape(k)))),
    el('div', { style: 'margin-top:6px;' }, [
      mkRow('N角形の角数', el('input', { type: 'number', min: 3, max: 32, value: polySides, onInput: (e) => { polySides = Math.max(3, parseInt(e.target.value, 10) || 6); } })),
      mkRow('分割数(滑らか)', el('input', { type: 'number', min: 4, max: 64, value: geoSegments, onInput: (e) => { geoSegments = Math.max(4, parseInt(e.target.value, 10) || 24); } }))
    ])
  ]),
  mkSec('配列複製 & 散布生成', [
    mkRow('軸 / 個数', el('div', { class: 'grid-2', style: 'flex:1;' }, [arrAxis, arrCount])),
    mkRow('間隔 / 半径', el('div', { class: 'grid-2', style: 'flex:1;' }, [arrStep, circRadius])),
    el('div', { class: 'grid-3' }, [
      mkBtn('直線配列', () => linearArray(arrAxis.value, +arrCount.value || 4, +arrStep.value || 1.2)),
      mkBtn('円形配列', () => circularArray(+arrCount.value || 6, +circRadius.value || 2.5)),
      mkBtn('散布生成', () => scatterObjects(+arrCount.value || 6, +circRadius.value || 4))
    ])
  ])
);

// タブ2: 構造
const searchInp = el('input', { type: 'text', placeholder: 'オブジェクト検索...', onInput: () => updateOutliner() });
const outlinerBox = el('div', { class: 'outliner' }), renameInp = el('input', { type: 'text', placeholder: '新しい名前' });
const dimBox = el('div', { style: 'font-size:11px;color:var(--muted);line-height:1.5;' });
panes.tree.append(
  mkSec('アウトライナー (シーン階層)', [
    searchInp, el('div', { style: 'height:5px' }), outlinerBox,
    el('div', { class: 'grid-3', style: 'margin-top:6px;' }, [
      mkBtn('全選択', () => setSelection(editorRoot.children.filter((o) => !o.userData.locked))),
      mkBtn('解除', () => setSelection([])),
      mkBtn('反転', () => setSelection(editorRoot.children.filter((o) => !o.userData.locked && !selected.includes(o))))
    ])
  ]),
  mkSec('名前・グループ・ロック', [
    el('div', { class: 'row' }, [renameInp, mkBtn('改名', () => { const p = primary(); if (p && renameInp.value.trim()) { p.name = renameInp.value.trim(); updateOutliner(); syncInspector(); pushHistory(); } })]),
    el('div', { class: 'grid-2' }, [
      mkBtn('グループ化', groupSelected), mkBtn('グループ解除', ungroupSelected),
      mkBtn('全表示に戻す', () => { getAllObjects().forEach((o) => { o.visible = true; }); updateOutliner(); }),
      mkBtn('全ロック解除', () => { getAllObjects().forEach((o) => { o.userData.locked = false; }); updateOutliner(); })
    ])
  ]),
  mkSec('計測 & バウンディング', [dimBox, el('div', { style: 'margin-top:5px;' }, [mkRow('選択枠表示', mkChk(showBoxHelper, (e) => { showBoxHelper = e.target.checked; updateSelectionBox(); }))])])
);

// タブ3: 変形
const numInputs = { pos: [], rot: [], sca: [] };
function applyNumericTransform() {
  const p = primary(); if (!p) return;
  p.position.set(+numInputs.pos[0].value || 0, +numInputs.pos[1].value || 0, +numInputs.pos[2].value || 0);
  p.rotation.set(...numInputs.rot.map((x) => THREE.MathUtils.degToRad(+x.value || 0)));
  p.scale.set(+numInputs.sca[0].value || 1, +numInputs.sca[1].value || 1, +numInputs.sca[2].value || 1);
  updateSelectionBox(); pushHistory();
}
const makeXYZ = (lbl, key, step) => {
  numInputs[key] = [0, 1, 2].map(() => mkNum('', { step }, applyNumericTransform));
  return mkRow(lbl, el('div', { class: 'grid-3', style: 'flex:1;' }, numInputs[key]));
};
const snapTransChk = mkChk(false, updateSnaps), snapTransVal = mkNum(0.5, { step: 0.25 }, updateSnaps);
const snapRotChk = mkChk(false, updateSnaps), snapRotVal = mkNum(15, { step: 5 }, updateSnaps);
const snapScaleChk = mkChk(false, updateSnaps), snapScaleVal = mkNum(0.25, { step: 0.1 }, updateSnaps);
function updateSnaps() {
  transform.setTranslationSnap(snapTransChk.checked ? Math.max(0.01, +snapTransVal.value || 0.5) : null);
  transform.setRotationSnap(snapRotChk.checked ? THREE.MathUtils.degToRad(+snapRotVal.value || 15) : null);
  transform.setScaleSnap(snapScaleChk.checked ? Math.max(0.01, +snapScaleVal.value || 0.25) : null);
}
panes.edit.append(
  mkSec('数値トランスフォーム', [
    makeXYZ('位置 X/Y/Z', 'pos', 0.1), makeXYZ('回転 (度)', 'rot', 5), makeXYZ('倍率 X/Y/Z', 'sca', 0.1),
    mkRow('均等拡大連動', mkChk(uniformScale, (e) => { uniformScale = e.target.checked; })),
    el('div', { class: 'grid-3' }, [
      mkBtn('位置0化', () => { selected.forEach((o) => o.position.set(0, 0, 0)); syncInspector(); pushHistory(); }),
      mkBtn('回転0化', () => { selected.forEach((o) => o.rotation.set(0, 0, 0)); syncInspector(); pushHistory(); }),
      mkBtn('倍率1化', () => { selected.forEach((o) => o.scale.set(1, 1, 1)); syncInspector(); pushHistory(); })
    ])
  ]),
  mkSec('スナップ & ギズモ', [
    mkRow('移動スナップ', el('div', { style: 'display:flex;gap:5px;flex:1;align-items:center;' }, [snapTransChk, snapTransVal])),
    mkRow('回転スナップ', el('div', { style: 'display:flex;gap:5px;flex:1;align-items:center;' }, [snapRotChk, snapRotVal])),
    mkRow('拡大スナップ', el('div', { style: 'display:flex;gap:5px;flex:1;align-items:center;' }, [snapScaleChk, snapScaleVal])),
    mkRow('ギズモサイズ', mkRange(0.5, 3.5, 0.1, 2.0, (e) => transform.setSize(+e.target.value)))
  ]),
  mkSec('配置・ミラー・複製', [
    el('div', { class: 'grid-2' }, [mkBtn('地面に接地', dropToFloor), mkBtn('XZ中央揃え', centerXZ), mkBtn('コピー', copySelected), mkBtn('ペースト', pasteClipboard)]),
    el('div', { class: 'grid-3', style: 'margin-top:4px;' }, ['x', 'y', 'z'].map((a) => mkBtn(`${a.toUpperCase()}ミラー`, () => mirrorDuplicate(a))))
  ]),
  mkSec('ジオメトリ加工・削除', [
    el('div', { class: 'grid-2' }, [
      mkBtn('2D押し出し', () => extrudeSelected2D(0.45)), mkBtn('メッシュ結合', mergeSelectedMeshes),
      mkBtn('凹凸Jitter', () => deformVertices('jitter', 0.2)), mkBtn('ツイスト捩り', () => deformVertices('twist', 0.6)),
      mkBtn('テーパー先細', () => deformVertices('taper', 0.3)), mkBtn('膨張Bulge', () => deformVertices('bulge', 0.6)),
      mkBtn('フラット面', () => setShadingMode(true)), mkBtn('スムーズ面', () => setShadingMode(false)),
      mkBtn('選択削除', deleteSelected, 'danger'),
      mkBtn('全消去', () => { setSelection([]); while (editorRoot.children.length) removeAndDispose(editorRoot.children[0]); pushHistory(); updateOutliner(); updateStats(); toast('全削除しました'); }, 'danger')
    ])
  ])
);

// タブ4: 質感
const colorPicker = el('input', { type: 'color', value: '#00ff88', onInput: (e) => applyColorHex(e.target.value, true), onChange: () => pushHistory() });
const hexInp = el('input', { type: 'text', placeholder: '#HEX (4/8桁対応)', onChange: (e) => { applyColorHex(e.target.value); pushHistory(); } });
const emissivePicker = el('input', { type: 'color', value: '#000000', onInput: (e) => selected.forEach((o) => getEditableMeshes(o).forEach((m) => m.material.emissive?.set(e.target.value))), onChange: () => pushHistory() });
const opacityRange = mkRange(0.05, 1, 0.01, 1, (e) => selected.forEach((o) => getEditableMeshes(o).forEach((m) => setMaterialOpacity(m.material, +e.target.value))), () => pushHistory());
const metalRange = mkRange(0, 1, 0.02, 0.1, (e) => selected.forEach((o) => getEditableMeshes(o).forEach((m) => { if ('metalness' in m.material) m.material.metalness = +e.target.value; })), () => pushHistory());
const roughRange = mkRange(0, 1, 0.02, 0.55, (e) => selected.forEach((o) => getEditableMeshes(o).forEach((m) => { if ('roughness' in m.material) m.material.roughness = +e.target.value; })), () => pushHistory());
const emissiveRange = mkRange(0, 3, 0.05, 1, (e) => selected.forEach((o) => getEditableMeshes(o).forEach((m) => { if ('emissiveIntensity' in m.material) m.material.emissiveIntensity = +e.target.value; })), () => pushHistory());
const wireChk = mkChk(false, (e) => { selected.forEach((o) => getEditableMeshes(o).forEach((m) => { m.material.wireframe = e.target.checked; })); pushHistory(); });
const doubleSideChk = mkChk(true, (e) => { selected.forEach((o) => getEditableMeshes(o).forEach((m) => { m.material.side = e.target.checked ? THREE.DoubleSide : THREE.FrontSide; m.material.needsUpdate = true; })); pushHistory(); });
const texFileInp = el('input', {
  type: 'file', accept: 'image/*', style: 'display:none',
  onChange: (e) => {
    const f = e.target.files[0]; if (!f) return;
    const r = new FileReader();
    r.onload = (ev) => {
      const url = ev.target.result, img = new Image();
      img.onload = () => {
        selected.forEach((o) => {
          o.userData.texPreset = 'image'; o.userData.texDataUrl = url;
          getEditableMeshes(o).forEach((m) => {
            const tex = new THREE.Texture(img); tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
            tex.repeat.set(...(o.userData.texRepeat || [1, 1])); tex.colorSpace = THREE.SRGBColorSpace; tex.needsUpdate = true;
            m.material.map = tex; m.material.needsUpdate = true;
          });
        });
        pushHistory(); toast('画像テクスチャを貼付しました');
      };
      img.src = url;
    };
    r.readAsDataURL(f); e.target.value = '';
  }
});
const texRepeatInp = mkNum(1, { min: 1, max: 20 }, (e) => {
  const r = Math.max(1, +e.target.value || 1);
  selected.forEach((o) => { o.userData.texRepeat = [r, r]; getEditableMeshes(o).forEach((m) => { if (m.material.map) m.material.map.repeat.set(r, r); }); });
  pushHistory();
});
const animSpeedInp = mkRange(0.2, 5, 0.1, 1, (e) => selected.forEach((o) => { if (o.userData.anim) o.userData.anim.speed = +e.target.value; }));
const animTypeSel = el('select', {
  onChange: (e) => { selected.forEach((o) => { resetAnimOffsets(o); o.userData.anim = { ...(o.userData.anim || {}), type: e.target.value, speed: +animSpeedInp.value || 1 }; }); pushHistory(); }
}, [['none', 'なし'], ['spinY', 'Y軸回転'], ['spinXYZ', '多軸回転'], ['bob', '上下浮遊'], ['pulse', '拡縮パルス']].map(([v, t]) => el('option', { value: v, text: t })));

panes.mat.append(
  mkSec('カラー & 発光', [
    el('div', { class: 'row' }, [colorPicker, hexInp, mkBtn('ランダム', () => { applyColorHex(Math.floor(Math.random() * 0xffffff).toString(16).padStart(6, '0'), true); pushHistory(); })]),
    el('div', { class: 'row' }, [el('label', { text: '発光色/強' }), emissivePicker, emissiveRange]),
    el('div', { class: 'grid-2' }, [
      mkBtn('質感コピー', () => { const m = getEditableMeshes(primary())[0]?.material; if (m) { matClipboard = m.clone(); toast('マテリアルをコピー'); } }),
      mkBtn('質感貼付', () => { if (!matClipboard) return; selected.forEach((o) => getEditableMeshes(o).forEach((m) => { m.material = matClipboard.clone(); })); syncInspector(); pushHistory(); toast('マテリアルを貼付'); })
    ])
  ]),
  mkSec('PBR パラメータ & 描画', [
    mkRow('不透明度', opacityRange), mkRow('金属度', metalRange), mkRow('粗さ', roughRange),
    el('div', { class: 'grid-2' }, [mkRow('ワイヤー', wireChk), mkRow('両面描画', doubleSideChk)]),
    el('div', { class: 'grid-5', style: 'margin-top:4px;' }, [['standard', '標準'], ['matte', 'マット'], ['metal', '金属'], ['glass', 'ガラス'], ['neon', 'ネオン']].map(([k, l]) => mkBtn(l, () => applyMaterialPreset(k))))
  ]),
  mkSec('テクスチャ (柄 / 画像)', [
    el('div', { class: 'grid-4' }, [['checker', 'チェック'], ['stripe', '縞模様'], ['grad', 'グラデ'], ['noise', 'ノイズ']].map(([k, l]) => mkBtn(l, () => {
      selected.forEach((o) => { o.userData.texPreset = k; o.userData.texDataUrl = null; getEditableMeshes(o).forEach((m) => { m.material.map = makePresetTexture(k, o.userData.texRepeat || [1, 1]); m.material.needsUpdate = true; }); });
      pushHistory();
    }))),
    el('div', { class: 'grid-2', style: 'margin-top:5px;' }, [
      mkBtn('画像貼付', () => texFileInp.click()),
      mkBtn('柄解除', () => { selected.forEach((o) => { o.userData.texPreset = 'none'; o.userData.texDataUrl = null; getEditableMeshes(o).forEach((m) => { m.material.map = null; m.material.needsUpdate = true; }); }); pushHistory(); })
    ]),
    texFileInp, mkRow('繰り返し数', texRepeatInp)
  ]),
  mkSec('簡易アニメーション', [mkRow('動き種類', animTypeSel), mkRow('再生速度', animSpeedInp), mkBtn('全体再生 / 一時停止', () => { animPlaying = !animPlaying; toast(animPlaying ? 'アニメ再生' : 'アニメ一時停止'); })])
);

// タブ5: 環境 & IO
const handleJsonUpload = (file, append = false) => {
  if (!file) return;
  const r = new FileReader();
  r.onload = (ev) => {
    try { loadSerializedScene(JSON.parse(ev.target.result), append); pushHistory(); toast(append ? 'シーンに追加しました' : 'シーンを読み込みました'); }
    catch (_) { toast('JSON読込エラー'); }
  };
  r.readAsText(file);
};
const jsonUploadInp = el('input', { type: 'file', accept: '.json', style: 'display:none', onChange: (e) => { handleJsonUpload(e.target.files[0], jsonUploadInp.dataset.append === '1'); e.target.value = ''; } });
const extUploadInp = el('input', { type: 'file', accept: '.glb,.gltf,.obj', style: 'display:none', onChange: (e) => { if (e.target.files[0]) importExternalModel(e.target.files[0]); e.target.value = ''; } });
const fogCol = el('input', { type: 'color', value: '#111318', onInput: updateFog }), fogDens = mkRange(0.005, 0.15, 0.005, 0.04, updateFog), fogChk = mkChk(false, updateFog);
function updateFog() { scene.fog = fogChk.checked ? new THREE.FogExp2(fogCol.value, +fogDens.value) : null; }
const lightAzim = mkRange(0, 360, 1, 45, updateDirLightPos), lightElev = mkRange(5, 89, 1, 55, updateDirLightPos);
function updateDirLightPos() {
  const a = THREE.MathUtils.degToRad(+lightAzim.value), elv = THREE.MathUtils.degToRad(+lightElev.value);
  dirLight.position.set(15 * Math.cos(elv) * Math.cos(a), 15 * Math.sin(elv), 15 * Math.cos(elv) * Math.sin(a));
}
function applyEnvPreset(t) {
  const c = { studio: ['#111318', 0.65, 1.2, '#ffffff'], day: ['#87ceeb', 0.85, 1.5, '#fffbeb'], sunset: ['#2b142c', 0.45, 1.6, '#fb923c'], night: ['#05070e', 0.25, 0.5, '#60a5fa'] }[t];
  if (!c) return;
  bgHex = c[0]; scene.background = new THREE.Color(bgHex); ambientLight.intensity = c[1]; dirLight.intensity = c[2]; dirLight.color.set(c[3]);
  toast(`環境プリセット: ${t}`);
}
panes.env.append(
  mkSec('カメラ & ビューポート', [
    el('div', { class: 'grid-4' }, [['front', '正面'], ['back', '背面'], ['left', '左'], ['right', '右'], ['top', '上面'], ['bottom', '下面'], ['iso', '斜め'], ['focus', '注目(F)']].map(([k, l]) => mkBtn(l, () => (k === 'focus' ? focusObject() : setCameraView(k))))),
    el('div', { class: 'grid-2', style: 'margin-top:5px;' }, [
      mkBtn('透視/平行 切替', toggleProjection),
      mkBtn('全体ワイヤー', () => { globalWireframe = !globalWireframe; editorRoot.traverse((c) => { if (c.isMesh && !c.userData.isLightProxy) c.material.wireframe = globalWireframe; }); })
    ]),
    mkRow('視野角 FOV', mkRange(20, 120, 1, 75, (e) => { perspCam.fov = +e.target.value; perspCam.updateProjectionMatrix(); })),
    mkRow('自動回転速度', mkRange(0.5, 10, 0.5, 2, (e) => { turntableSpeed = +e.target.value; }))
  ]),
  mkSec('背景・フォグ・グリッド', [
    mkRow('背景色', el('input', { type: 'color', value: bgHex, onInput: (e) => { bgHex = e.target.value; scene.background = new THREE.Color(bgHex); } })),
    el('div', { class: 'row' }, [el('label', { text: 'フォグ(霧)' }), fogChk, fogCol, fogDens]),
    el('div', { class: 'grid-2' }, [mkRow('グリッド', mkChk(true, (e) => { gridHelper.visible = e.target.checked; })), mkRow('座標軸', mkChk(false, (e) => { axesHelper.visible = e.target.checked; }))]),
    mkRow('グリッド幅', mkNum(20, { min: 4, max: 100 }, (e) => {
      const s = Math.max(4, +e.target.value || 20), vis = gridHelper.visible;
      scene.remove(gridHelper); gridHelper.geometry.dispose(); gridHelper.material.dispose();
      gridHelper = new THREE.GridHelper(s, s, 0x4b5563, 0x222631); gridHelper.visible = vis; scene.add(gridHelper);
    }))
  ]),
  mkSec('ライティング & 影', [
    mkRow('環境光 強', mkRange(0, 2, 0.05, 0.65, (e) => { ambientLight.intensity = +e.target.value; })),
    mkRow('平行光 強', mkRange(0, 3, 0.05, 1.2, (e) => { dirLight.intensity = +e.target.value; })),
    mkRow('光 方位角', lightAzim), mkRow('光 仰角', lightElev),
    el('div', { class: 'grid-2' }, [mkRow('影 Shadow', mkChk(true, (e) => { renderer.shadowMap.enabled = e.target.checked; shadowFloor.visible = e.target.checked; })), mkRow('半球光', mkChk(true, (e) => { hemiLight.visible = e.target.checked; }))]),
    el('div', { class: 'grid-4', style: 'margin-top:4px;' }, [['studio', 'スタジオ'], ['day', '昼'], ['sunset', '夕方'], ['night', '夜']].map(([k, l]) => mkBtn(l, () => applyEnvPreset(k))))
  ]),
  mkSec('保存 / 読込 / 3D書出 & 撮影', [
    el('div', { class: 'grid-3' }, [
      mkBtn('JSON保存', () => exportModel('json'), 'primary'),
      mkBtn('JSON読込', () => { jsonUploadInp.dataset.append = '0'; jsonUploadInp.click(); }),
      mkBtn('JSON追加', () => { jsonUploadInp.dataset.append = '1'; jsonUploadInp.click(); })
    ]),
    el('div', { class: 'grid-4', style: 'margin-top:4px;' }, ['glb', 'gltf', 'obj', 'stl'].map((f) => mkBtn(`${f.toUpperCase()}書出`, () => exportModel(f)))),
    el('div', { class: 'grid-3', style: 'margin-top:4px;' }, [mkBtn('GLB/OBJ読込', () => extUploadInp.click()), mkBtn('PNG撮影', () => takeScreenshot(false)), mkBtn('透過PNG', () => takeScreenshot(true))]),
    el('div', { class: 'grid-2', style: 'margin-top:4px;' }, [
      mkBtn('オートセーブ復元', () => { const s = localStorage.getItem('3875d_autosave'); if (s) { loadSerializedScene(JSON.parse(s)); pushHistory(); toast('自動保存から復元しました'); } else toast('保存データなし'); }),
      mkBtn('自動保存消去', () => { localStorage.removeItem('3875d_autosave'); toast('自動保存を削除しました'); })
    ]),
    jsonUploadInp, extUploadInp
  ])
);

// === 10. ツールバー・同期・グローバル互換API・ループ ===
const toolbar = document.getElementById('toolbar'), modeBtns = {};
const spaceBtn = mkBtn('座標:World', () => {
  currentSpace = currentSpace === 'world' ? 'local' : 'world';
  transform.setSpace(currentSpace);
  spaceBtn.textContent = `座標:${currentSpace === 'world' ? 'World' : 'Local'}`;
});
const turnBtn = mkBtn('回転台', () => { turntable = !turntable; orbit.autoRotate = turntable; turnBtn.classList.toggle('active', turntable); });
function setMode(mode) {
  currentMode = mode; transform.setMode(mode);
  Object.entries(modeBtns).forEach(([k, b]) => b.classList.toggle('active', k === mode));
}
[['translate', '移動(W)'], ['rotate', '回転(E)'], ['scale', '拡大(R)']].forEach(([m, l], i) => {
  const b = mkBtn(l, () => setMode(m), i === 0 ? 'active' : ''); modeBtns[m] = b; toolbar.appendChild(b);
});
toolbar.append(spaceBtn, mkBtn('Undo', undo), mkBtn('Redo', redo), mkBtn('複製', () => duplicateSelected()), mkBtn('注目', () => focusObject()), turnBtn, mkBtn('削除', deleteSelected, 'danger'));

function updateOutliner() {
  outlinerBox.innerHTML = '';
  const q = searchInp.value.trim().toLowerCase();
  const renderNode = (obj, depth = 0) => {
    if (!q || obj.name.toLowerCase().includes(q)) {
      outlinerBox.appendChild(el('div', {
        class: `out-item ${selected.includes(obj) ? 'selected' : ''}`, style: `padding-left:${5 + depth * 12}px;`,
        onClick: (e) => {
          if (e.target.tagName === 'BUTTON') return;
          if (obj.userData.locked) return toast('ロック中です');
          setSelection(e.shiftKey ? (selected.includes(obj) ? selected.filter((x) => x !== obj) : [...selected, obj]) : [obj]);
        }
      }, [
        el('span', { class: 'name', text: `${obj.userData.kind === 'group' ? '📁 ' : ''}${obj.name}` }),
        mkBtn(obj.visible ? '👁' : '🚫', () => { obj.visible = !obj.visible; updateOutliner(); }),
        mkBtn(obj.userData.locked ? '🔒' : '🔓', () => {
          obj.userData.locked = !obj.userData.locked;
          if (obj.userData.locked && selected.includes(obj)) setSelection(selected.filter((x) => x !== obj)); else updateOutliner();
        })
      ]));
    }
    if (obj.isGroup && obj.userData.kind === 'group') obj.children.forEach((c) => renderNode(c, depth + 1));
  };
  editorRoot.children.forEach((o) => renderNode(o));
}

function syncInspector() {
  const p = primary();
  document.getElementById('sel-badge').textContent = p ? (selected.length > 1 ? `${selected.length}個選択中` : p.name) : '未選択';
  if (!p) {
    [...numInputs.pos, ...numInputs.rot, ...numInputs.sca, renameInp, hexInp].forEach((i) => { if (i && document.activeElement !== i) i.value = ''; });
    dimBox.textContent = 'オブジェクトを選択すると寸法を表示します';
    return;
  }
  const act = document.activeElement, setVal = (i, v) => { if (act !== i) i.value = v; };
  [p.position.x, p.position.y, p.position.z].forEach((v, idx) => setVal(numInputs.pos[idx], v.toFixed(2)));
  [p.rotation.x, p.rotation.y, p.rotation.z].forEach((v, idx) => setVal(numInputs.rot[idx], THREE.MathUtils.radToDeg(v).toFixed(1)));
  [p.scale.x, p.scale.y, p.scale.z].forEach((v, idx) => setVal(numInputs.sca[idx], v.toFixed(2)));
  setVal(renameInp, p.name);
  const m = getEditableMeshes(p)[0]?.material;
  if (m) {
    const hex6 = '#' + m.color.getHexString(); colorPicker.value = hex6;
    const alphaHex = m.opacity < 0.995 ? Math.round(m.opacity * 255).toString(16).padStart(2, '0') : '';
    setVal(hexInp, hex6 + alphaHex);
    opacityRange.value = m.opacity; metalRange.value = m.metalness ?? 0.1; roughRange.value = m.roughness ?? 0.55;
    if (m.emissive) emissivePicker.value = '#' + m.emissive.getHexString();
    emissiveRange.value = m.emissiveIntensity ?? 1; wireChk.checked = !!m.wireframe; doubleSideChk.checked = m.side === THREE.DoubleSide;
  }
  animTypeSel.value = p.userData.anim?.type || 'none'; animSpeedInp.value = p.userData.anim?.speed ?? 1;
  p.updateMatrixWorld(true);
  const b = new THREE.Box3().setFromObject(p);
  if (!b.isEmpty()) { const sz = b.getSize(new THREE.Vector3()); dimBox.textContent = `寸法: W ${sz.x.toFixed(2)} × H ${sz.y.toFixed(2)} × D ${sz.z.toFixed(2)}`; }
}

function updateStats() {
  let objs = 0, verts = 0, tris = 0;
  editorRoot.traverse((c) => {
    if (c !== editorRoot) objs++;
    if (c.isMesh && !c.userData.isLightProxy) {
      verts += c.geometry.attributes.position?.count || 0;
      tris += c.geometry.index ? c.geometry.index.count / 3 : (c.geometry.attributes.position?.count || 0) / 3;
    }
  });
  document.getElementById('stats-box').innerHTML = `Obj: ${objs} | 頂点: ${verts} | 面: ${Math.round(tris)}<br>履歴: ${historyIdx + 1}/${historyStack.length} | Draw: ${renderer.info.render.calls}`;
}

window.createShape = (type) => addShape(type);
window.deleteObject = deleteSelected;
window.updateColor = (hex) => { applyColorHex(hex); pushHistory(); };
window.setMode = setMode;
window.downloadScene = () => exportModel('json');
window.uploadScene = (e) => handleJsonUpload(e?.target?.files?.[0], false);

document.getElementById('toggle-panel-btn').addEventListener('click', () => document.getElementById('main-panel').classList.toggle('collapsed'));
const helpModal = document.getElementById('help-modal');
document.getElementById('help-btn').addEventListener('click', () => helpModal.classList.add('open'));
document.getElementById('close-help').addEventListener('click', () => helpModal.classList.remove('open'));
helpModal.addEventListener('click', (e) => { if (e.target === helpModal) helpModal.classList.remove('open'); });

window.addEventListener('keydown', (e) => {
  if (['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName)) return;
  const k = e.key.toLowerCase();
  if ((e.ctrlKey || e.metaKey) && k === 'z') { e.preventDefault(); undo(); }
  else if ((e.ctrlKey || e.metaKey) && k === 'y') { e.preventDefault(); redo(); }
  else if ((e.ctrlKey || e.metaKey) && k === 'd') { e.preventDefault(); duplicateSelected(); }
  else if ((e.ctrlKey || e.metaKey) && k === 'c') { e.preventDefault(); copySelected(); }
  else if ((e.ctrlKey || e.metaKey) && k === 'v') { e.preventDefault(); pasteClipboard(); }
  else if ((e.ctrlKey || e.metaKey) && k === 'a') { e.preventDefault(); setSelection(editorRoot.children.filter((o) => !o.userData.locked)); }
  else if (k === 'w') setMode('translate');
  else if (k === 'e') setMode('rotate');
  else if (k === 'r') setMode('scale');
  else if (k === 'q') spaceBtn.click();
  else if (k === 'f') focusObject();
  else if (k === 'escape') setSelection([]);
  else if (e.key === 'Delete' || e.key === 'Backspace') deleteSelected();
});

window.addEventListener('resize', () => {
  perspCam.aspect = innerWidth / innerHeight; perspCam.updateProjectionMatrix();
  updateOrthoFrustum(); renderer.setSize(innerWidth, innerHeight);
});

const clock = new THREE.Clock();
let elapsed = 0;
if (localStorage.getItem('3875d_autosave')) {
  try { loadSerializedScene(JSON.parse(localStorage.getItem('3875d_autosave'))); toast('前回の自動保存を復元しました'); }
  catch (_) { addShape('cube', true); }
} else addShape('cube', true);
pushHistory();

function animate() {
  requestAnimationFrame(animate);
  const dt = Math.min(clock.getDelta(), 0.05); elapsed += dt;
  if (turntable) orbit.autoRotateSpeed = turntableSpeed;
  orbit.update();
  if (animPlaying && !transform.dragging) {
    editorRoot.traverse((o) => {
      const a = o.userData.anim; if (!a || a.type === 'none') return;
      const spd = a.speed || 1;
      if (a.type === 'spinY') o.rotation.y += dt * spd;
      else if (a.type === 'spinXYZ') { o.rotation.x += dt * spd * 0.7; o.rotation.y += dt * spd; }
      else if (a.type === 'bob') {
        if (o.userData._bobY) o.position.y -= o.userData._bobY;
        const nb = Math.sin(elapsed * spd * 2) * 0.35; o.position.y += nb; o.userData._bobY = nb;
      } else if (a.type === 'pulse') {
        if (o.userData._pulseF && o.userData._pulseF !== 1) o.scale.divideScalar(o.userData._pulseF);
        const nf = 1 + Math.sin(elapsed * spd * 3) * 0.18; o.scale.multiplyScalar(nf); o.userData._pulseF = nf;
      }
    });
  }
  if (primary() && showBoxHelper && boxHelper.visible) boxHelper.update();
  renderer.render(scene, activeCam);
}
animate();