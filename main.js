import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { OBJExporter } from 'three/addons/exporters/OBJExporter.js';
import { STLExporter } from 'three/addons/exporters/STLExporter.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { MTLLoader } from 'three/addons/loaders/MTLLoader.js';
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
  toastTimer = setTimeout(() => toastEl.classList.remove('show'), 2200);
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
const getMats = (mesh) => (Array.isArray(mesh?.material) ? mesh.material : [mesh?.material]).filter(Boolean);
const disposeObjectTree = (obj) => obj.traverse((c) => {
  c.geometry?.dispose();
  getMats(c).forEach((m) => { m.map?.dispose(); m.dispose(); });
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
    if (n.isMesh) {
      n.geometry = n.geometry.clone();
      n.material = Array.isArray(n.material) ? n.material.map((m) => m.clone()) : n.material.clone();
    }
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
  const baseMat = getMats(meshes[meshes.length - 1])[0];
  const mesh = new THREE.Mesh(merged, baseMat ? baseMat.clone() : createMat());
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
    pos.needsUpdate = true; g.co
