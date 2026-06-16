/**
 * 点云边缘真值提取平台 — 3D Viewer & Frontend Logic
 * Three.js + OrbitControls
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

// ---- DOM refs ----
const $ = (s) => document.querySelector(s);
const uploadZone = $('#uploadZone');
const fileInput = $('#fileInput');
const fileInfo = $('#fileInfo');
const fileName = $('#fileName');
const clearFileBtn = $('#clearFileBtn');
const uploadStatus = $('#uploadStatus');
const extractBtn = $('#extractBtn');
const extractStatus = $('#extractStatus');
const angleThreshold = $('#angleThreshold');
const angleValue = $('#angleValue');
const sampleDensity = $('#sampleDensity');
const densityValue = $('#densityValue');
const minSamples = $('#minSamples');
const minSamplesValue = $('#minSamplesValue');
const statsCard = $('#statsCard');
const statsGrid = $('#statsGrid');
const downloadCard = $('#downloadCard');
const downloadPlyBtn = $('#downloadPlyBtn');
const downloadTxtBtn = $('#downloadTxtBtn');
const viewerToolbar = $('#viewerToolbar');
const viewerCanvas = $('#viewerCanvas');
const viewerPlaceholder = $('#viewerPlaceholder');
const viewerLegend = $('#viewerLegend');
const loadingOverlay = $('#loadingOverlay');
const loadingText = $('#loadingText');
const toastContainer = $('#toastContainer');
const toggleMesh = $('#toggleMesh');
const toggleEdges = $('#toggleEdges');
const togglePoints = $('#togglePoints');
const resetCameraBtn = $('#resetCameraBtn');

// ---- State ----
let sessionId = null;
let currentFile = null;

// ---- Three.js globals ----
let scene, camera, renderer, controls;
let meshGroup, edgeGroup, pointGroup;
let sceneReady = false;
let defaultCamPos, defaultTarget;

// ================================================================
// Scene setup
// ================================================================
function initScene() {
    if (sceneReady) return;
    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0f0f1a);
    scene.fog = new THREE.Fog(0x0f0f1a, 50, 200);

    const rect = viewerCanvas.getBoundingClientRect();
    camera = new THREE.PerspectiveCamera(50, rect.width / Math.max(rect.height, 1), 0.1, 1000);
    camera.position.set(8, 6, 10);

    renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(rect.width, rect.height);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    viewerCanvas.appendChild(renderer.domElement);

    controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.target.set(0, 0, 0);
    controls.update();

    scene.add(new THREE.AmbientLight(0x404060, 1.5));
    const dl = new THREE.DirectionalLight(0xffffff, 2);
    dl.position.set(10, 20, 10);
    scene.add(dl);
    const dl2 = new THREE.DirectionalLight(0x8888cc, 0.8);
    dl2.position.set(-10, -2, -5);
    scene.add(dl2);

    scene.add(new THREE.GridHelper(20, 20, 0x333355, 0x1a1a2e));
    scene.add(new THREE.AxesHelper(3));

    meshGroup = new THREE.Group();
    edgeGroup = new THREE.Group();
    pointGroup = new THREE.Group();
    scene.add(meshGroup);
    scene.add(edgeGroup);
    scene.add(pointGroup);

    defaultCamPos = camera.position.clone();
    defaultTarget = controls.target.clone();

    window.addEventListener('resize', () => {
        if (!renderer) return;
        const r = viewerCanvas.getBoundingClientRect();
        camera.aspect = r.width / Math.max(r.height, 1);
        camera.updateProjectionMatrix();
        renderer.setSize(r.width, r.height);
    });

    sceneReady = true;
    (function loop() {
        requestAnimationFrame(loop);
        controls.update();
        renderer.render(scene, camera);
    })();
}

// ================================================================
// Clear & render helpers
// ================================================================
function disposeGroup(g) {
    while (g.children.length) {
        const c = g.children[0];
        if (c.geometry) c.geometry.dispose();
        if (c.material) {
            (Array.isArray(c.material) ? c.material : [c.material]).forEach(m => m.dispose());
        }
        g.remove(c);
    }
}

function clearSceneObjs() {
    [meshGroup, edgeGroup, pointGroup].forEach(disposeGroup);
}

function renderMesh(meshData) {
    const verts = new Float32Array(meshData.vertices.flat());
    const idx = meshData.faces.flat();
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(verts, 3));
    geom.setIndex(idx);
    geom.computeVertexNormals();

    // Semi-transparent surface
    const faceMat = new THREE.MeshPhongMaterial({
        color: 0x334466, transparent: true, opacity: 0.12,
        side: THREE.DoubleSide, depthWrite: false,
    });
    meshGroup.add(new THREE.Mesh(geom, faceMat));

    // Wireframe edges
    const eGeom = new THREE.EdgesGeometry(geom, 30);
    meshGroup.add(new THREE.LineSegments(eGeom,
        new THREE.LineBasicMaterial({ color: 0x888899, transparent: true, opacity: 0.45 })));
}

function renderEdges(edgeData) {
    // Edge line segments
    const pos = edgeData.segments.flatMap(s => [s.start[0], s.start[1], s.start[2], s.end[0], s.end[1], s.end[2]]);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
    edgeGroup.add(new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: 0xff4444 })));

    // Edge sample points (sprites)
    if (edgeData.points && edgeData.points.length) {
        const pf = new Float32Array(edgeData.points.flat());
        const pg = new THREE.BufferGeometry();
        pg.setAttribute('position', new THREE.BufferAttribute(pf, 3));
        const cvs = document.createElement('canvas');
        cvs.width = cvs.height = 16;
        const ctx = cvs.getContext('2d');
        ctx.fillStyle = '#ffaa00';
        ctx.beginPath(); ctx.arc(8, 8, 4, 0, Math.PI * 2); ctx.fill();
        pointGroup.add(new THREE.Points(pg, new THREE.PointsMaterial({
            size: 0.06, map: new THREE.CanvasTexture(cvs),
            blending: THREE.AdditiveBlending, depthWrite: false, color: 0xffaa00,
        })));
    }
}

function fitCamera(bbox) {
    if (!bbox) return;
    const s = Math.max(...bbox.size);
    const d = s * 2.5;
    const [cx, cy, cz] = bbox.center;
    controls.target.set(cx, cy, cz);
    camera.position.set(cx + d * 0.7, cy + d * 0.5, cz + d * 0.7);
    controls.update();
    defaultCamPos = camera.position.clone();
    defaultTarget = controls.target.clone();

    // Resize grid
    const oldGrid = scene.children.find(c => c.isGridHelper);
    if (oldGrid) scene.remove(oldGrid);
    const grid = new THREE.GridHelper(s * 3, 20, 0x333355, 0x1a1a2e);
    grid.position.set(cx, bbox.min[1] - s * 0.05, cz);
    scene.add(grid);
}

// ================================================================
// UI helpers
// ================================================================
function showLoading(txt) { loadingText.textContent = txt; loadingOverlay.style.display = 'flex'; }
function hideLoading() { loadingOverlay.style.display = 'none'; }

function toast(msg, type) {
    const el = document.createElement('div');
    el.className = 'toast ' + (type || '');
    el.textContent = msg;
    toastContainer.appendChild(el);
    setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity 0.3s'; setTimeout(() => el.remove(), 300); }, 3500);
}

function showStats(st) {
    const items = [
        ['顶点数', st.vertex_count], ['三角面数', st.face_count],
        ['尖锐边缘', st.sharp_edge_count], ['边界边', st.boundary_count],
        ['二面角边缘', st.dihedral_count], ['边缘采样点', st.edge_point_count],
    ];
    statsGrid.innerHTML = items.map(([l, v]) =>
        `<div class="stat-item"><div class="stat-value">${v.toLocaleString()}</div><div class="stat-label">${l}</div></div>`
    ).join('');
    statsCard.style.display = '';
}

// ================================================================
// API calls
// ================================================================
async function apiUpload(file) {
    showLoading('正在上传并解析 OBJ...');
    const fd = new FormData(); fd.append('file', file);
    try {
        const r = await fetch('/api/upload', { method: 'POST', body: fd });
        const d = await r.json();
        hideLoading();
        if (!d.success) { uploadStatus.textContent = d.error; uploadStatus.className = 'upload-status error'; toast(d.error, 'error'); return null; }
        uploadStatus.textContent = `✓ 上传成功 — ${d.vertex_count.toLocaleString()} 顶点, ${d.face_count.toLocaleString()} 面`;
        uploadStatus.className = 'upload-status success';
        extractBtn.disabled = false;
        return d;
    } catch (e) { hideLoading(); toast('上传失败: ' + e.message, 'error'); return null; }
}

async function apiExtract() {
    if (!sessionId) { toast('请先上传 OBJ 文件', 'error'); return null; }
    showLoading('正在提取边缘...');
    try {
        const r = await fetch('/api/extract', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                session_id: sessionId,
                angle_threshold: parseFloat(angleThreshold.value),
                sample_density: parseFloat(sampleDensity.value),
                min_samples: parseInt(minSamples.value),
            }),
        });
        const d = await r.json();
        hideLoading();
        if (!d.success) { extractStatus.textContent = d.error; extractStatus.className = 'extract-status error'; toast(d.error, 'error'); return null; }
        extractStatus.textContent = `✓ 提取完成 — ${d.stats.sharp_edge_count} 条边缘, ${d.stats.edge_point_count.toLocaleString()} 个点`;
        extractStatus.className = 'extract-status success';
        return d;
    } catch (e) { hideLoading(); toast('提取失败: ' + e.message, 'error'); return null; }
}

// ================================================================
// Main flow
// ================================================================
async function handleFile(file) {
    if (!file.name.toLowerCase().endsWith('.obj')) { toast('仅支持 .obj 文件', 'error'); return; }
    currentFile = file;
    fileName.textContent = file.name;
    fileInfo.style.display = 'flex';
    uploadZone.classList.add('has-file');
    uploadZone.querySelector('.upload-icon').style.display = 'none';
    uploadZone.querySelector('.upload-text').style.display = 'none';
    const r = await apiUpload(file);
    if (r) { sessionId = r.session_id; await doExtract(); }
}

function clearFile() {
    currentFile = null; sessionId = null;
    fileInput.value = ''; fileInfo.style.display = 'none';
    uploadZone.classList.remove('has-file');
    uploadZone.querySelector('.upload-icon').style.display = '';
    uploadZone.querySelector('.upload-text').style.display = '';
    uploadStatus.textContent = ''; extractStatus.textContent = '';
    extractBtn.disabled = true;
    statsCard.style.display = 'none'; downloadCard.style.display = 'none';
}

async function doExtract() {
    const r = await apiExtract();
    if (!r) return;
    initScene(); clearSceneObjs();
    if (r.mesh_data) renderMesh(r.mesh_data);
    if (r.edge_data) renderEdges(r.edge_data);
    if (r.bbox) fitCamera(r.bbox);
    viewerPlaceholder.style.display = 'none';
    viewerToolbar.style.display = 'flex';
    viewerLegend.style.display = 'flex';
    showStats(r.stats);
    downloadCard.style.display = '';
    toggleMesh.checked = toggleEdges.checked = togglePoints.checked = true;
}

// ---- Events ----
uploadZone.addEventListener('click', e => { if (e.target !== clearFileBtn) fileInput.click(); });
uploadZone.addEventListener('dragover', e => { e.preventDefault(); uploadZone.classList.add('dragover'); });
uploadZone.addEventListener('dragleave', () => uploadZone.classList.remove('dragover'));
uploadZone.addEventListener('drop', e => { e.preventDefault(); uploadZone.classList.remove('dragover'); if (e.dataTransfer.files.length) handleFile(e.dataTransfer.files[0]); });
fileInput.addEventListener('change', () => { if (fileInput.files.length) handleFile(fileInput.files[0]); });
clearFileBtn.addEventListener('click', e => { e.stopPropagation(); clearFile(); });
extractBtn.addEventListener('click', doExtract);
angleThreshold.addEventListener('input', () => { angleValue.textContent = parseFloat(angleThreshold.value).toFixed(1) + '°'; });
sampleDensity.addEventListener('input', () => { densityValue.textContent = parseFloat(sampleDensity.value).toFixed(1) + ' 点/单位'; });
minSamples.addEventListener('input', () => { minSamplesValue.textContent = minSamples.value; });
toggleMesh.addEventListener('change', () => { meshGroup.visible = toggleMesh.checked; });
toggleEdges.addEventListener('change', () => { edgeGroup.visible = toggleEdges.checked; });
togglePoints.addEventListener('change', () => { pointGroup.visible = togglePoints.checked; });
resetCameraBtn.addEventListener('click', () => {
    if (defaultCamPos && defaultTarget) { camera.position.copy(defaultCamPos); controls.target.copy(defaultTarget); controls.update(); }
});
downloadPlyBtn.addEventListener('click', () => { if (sessionId) window.open('/api/download/' + sessionId + '/ply', '_blank'); });
downloadTxtBtn.addEventListener('click', () => { if (sessionId) window.open('/api/download/' + sessionId + '/txt', '_blank'); });
document.addEventListener('keydown', e => { if (e.key === 'r' && !e.ctrlKey && !e.metaKey && document.activeElement === document.body) resetCameraBtn.click(); });

console.log('点云边缘真值提取平台 — 前端就绪');
