import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { TransformControls } from 'three/addons/controls/TransformControls.js';

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);
const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
renderer.setPixelRatio(window.devicePixelRatio);
renderer.setSize(window.innerWidth, window.innerHeight);
document.body.appendChild(renderer.domElement);

const ambient = new THREE.AmbientLight(0xffffff, 0.7);
const directional = new THREE.DirectionalLight(0xffffff, 1);
directional.position.set(5, 10, 7);
scene.add(ambient, directional);
scene.add(new THREE.GridHelper(20, 20, 0x444444, 0x222222));

camera.position.set(5, 5, 5);
const orbit = new OrbitControls(camera, renderer.domElement);
const transform = new TransformControls(camera, renderer.domElement);
transform.setSize(2.5); 
scene.add(transform);

transform.addEventListener('dragging-changed', (e) => orbit.enabled = !e.value);

let objects = [];
let selectedObject = null;

transform.addEventListener('objectChange', () => {
    if (transform.object) {
        selectedObject = transform.object;
        const hex = "#" + selectedObject.material.color.getHexString();
        document.getElementById('color-hex').value = hex;
    }
});

window.createShape = (type) => {
    let geo;
    const mat = new THREE.MeshStandardMaterial({ 
        color: 0x00ff88, 
        side: THREE.DoubleSide, 
        transparent: true,
        opacity: 1.0 
    });

    if (type === 'cube') geo = new THREE.BoxGeometry(1, 1, 1);
    else if (type === 'sphere') geo = new THREE.SphereGeometry(0.7, 32, 32);
    else if (type === 'rod') geo = new THREE.CylinderGeometry(0.2, 0.2, 2, 32);
    else if (type === 'plane') geo = new THREE.PlaneGeometry(1, 1);
    else if (type === 'circle') geo = new THREE.CircleGeometry(0.7, 32);
    else if (type === 'poly') geo = new THREE.CircleGeometry(0.7, 6);
    else if (type === 'line') geo = new THREE.PlaneGeometry(0.05, 2);
    
    const mesh = new THREE.Mesh(geo, mat);
    scene.add(mesh);
    objects.push(mesh);
    transform.attach(mesh);
    selectedObject = mesh;
};

window.deleteObject = () => {
    if (transform.object) {
        const obj = transform.object;
        transform.detach();
        scene.remove(obj);
        objects = objects.filter(o => o !== obj);
        selectedObject = null;
    }
};

window.updateColor = (hex) => {
    if (!selectedObject) return;
    let cleanHex = hex.replace('#', '');
    
    if (cleanHex.length === 4 || cleanHex.length === 8) {
        const alphaPart = cleanHex.length === 4 ? cleanHex.slice(3, 4).repeat(2) : cleanHex.slice(6, 8);
        const opacity = parseInt(alphaPart, 16) / 255;
        selectedObject.material.opacity = opacity;
        cleanHex = cleanHex.length === 4 ? cleanHex.slice(0, 3) : cleanHex.slice(0, 6);
    } else {
        selectedObject.material.opacity = 1.0;
    }
    selectedObject.material.color.set('#' + cleanHex);
};

window.setMode = (mode) => {
    transform.setMode(mode);
    document.querySelectorAll('.toolbar button').forEach(b => b.classList.remove('active'));
    document.getElementById(`btn-${mode[0]}`).classList.add('active');
};

window.downloadScene = () => {
    const data = objects.map(obj => ({
        type: obj.geometry.type,
        parameters: obj.geometry.parameters,
        pos: obj.position.toArray(),
        rot: [obj.rotation.x, obj.rotation.y, obj.rotation.z],
        sca: obj.scale.toArray(),
        col: "#" + obj.material.color.getHexString(),
        op: obj.material.opacity
    }));
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([JSON.stringify(data)], {type: 'application/json'}));
    a.download = 'scene.json';
    a.click();
};

window.uploadScene = (event) => {
    const reader = new FileReader();
    reader.onload = (e) => {
        const data = JSON.parse(e.target.result);
        objects.forEach(obj => scene.remove(obj));
        objects = [];
        data.forEach(d => {
            const mesh = rebuildMesh(d);
            scene.add(mesh);
            objects.push(mesh);
        });
    };
    reader.readAsText(event.target.files[0]);
};

function rebuildMesh(d) {
    let geo;
    const type = d.type;
    if (type.includes('Box')) geo = new THREE.BoxGeometry(1,1,1);
    else if (type.includes('Sphere')) geo = new THREE.SphereGeometry(0.7, 32, 32);
    else if (type.includes('Cylinder')) geo = new THREE.CylinderGeometry(0.2, 0.2, 2, 32);
    else if (type.includes('Plane')) geo = new THREE.PlaneGeometry(1, 1);
    else if (type.includes('Circle')) {
        const segments = d.parameters.segments;
        geo = new THREE.CircleGeometry(0.7, segments);
    }
    
    const mat = new THREE.MeshStandardMaterial({ color: d.col, side: THREE.DoubleSide, transparent: true, opacity: d.op });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.fromArray(d.pos);
    mesh.rotation.set(d.rot[0], d.rot[1], d.rot[2]);
    mesh.scale.fromArray(d.sca);
    return mesh;
}

function animate() {
    requestAnimationFrame(animate);
    renderer.render(scene, camera);
}
animate();

window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
});
