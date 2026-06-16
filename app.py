"""
点云边缘真值提取平台 - Ground Truth Edge Extraction Platform
================================================================
基于二面角的方法从OBJ三维网格模型中提取几何尖锐边缘作为真值。

方法：
  计算相邻三角面之间的二面角，超过阈值（默认25°）的边即为尖锐边缘。
  对网格的边界边也标记为边缘。沿每条边缘线段均匀采样，生成边缘点云。

Usage:
  pip install -r requirements.txt
  python app.py
  然后访问 http://localhost:5000
"""

import os
import math
import json
import uuid
import shutil
from pathlib import Path
from flask import Flask, render_template, request, jsonify, send_file
from werkzeug.utils import secure_filename

# ============================================================
# Flask 应用初始化
# ============================================================
app = Flask(__name__)

BASE_DIR = Path(__file__).resolve().parent
UPLOAD_FOLDER = BASE_DIR / 'uploads'
OUTPUT_FOLDER = BASE_DIR / 'outputs'
ALLOWED_EXTENSIONS = {'obj'}

UPLOAD_FOLDER.mkdir(exist_ok=True)
OUTPUT_FOLDER.mkdir(exist_ok=True)

app.config['UPLOAD_FOLDER'] = str(UPLOAD_FOLDER)
app.config['OUTPUT_FOLDER'] = str(OUTPUT_FOLDER)
app.config['MAX_CONTENT_LENGTH'] = 200 * 1024 * 1024  # 200MB

# 内存中的会话存储（生产环境应使用 Redis 等）
sessions = {}


# ============================================================
# 核心算法：OBJ解析 & 二面角边缘提取
# ============================================================

def parse_obj(filepath):
    """
    解析 OBJ 文件，返回 (vertices, faces)。
    vertices: [(x, y, z), ...]
    faces: [(v0, v1, v2), ...]  — 已三角剖分
    """
    vertices = []
    faces = []
    with open(filepath, 'r', encoding='utf-8', errors='ignore') as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            parts = line.split()
            if parts[0] == 'v':
                vertices.append((float(parts[1]), float(parts[2]), float(parts[3])))
            elif parts[0] == 'f':
                idxs = [int(p.split('/')[0]) - 1 for p in parts[1:]]
                if len(idxs) >= 3:
                    # 扇形三角剖分
                    for i in range(1, len(idxs) - 1):
                        faces.append((idxs[0], idxs[i], idxs[i + 1]))
    return vertices, faces


def compute_normal(v1, v2, v3):
    """计算三角面的单位法向量"""
    e1 = (v2[0] - v1[0], v2[1] - v1[1], v2[2] - v1[2])
    e2 = (v3[0] - v1[0], v3[1] - v1[1], v3[2] - v1[2])
    nx = e1[1] * e2[2] - e1[2] * e2[1]
    ny = e1[2] * e2[0] - e1[0] * e2[2]
    nz = e1[0] * e2[1] - e1[1] * e2[0]
    length = math.sqrt(nx * nx + ny * ny + nz * nz)
    if length < 1e-12:
        return (0.0, 0.0, 0.0)
    return (nx / length, ny / length, nz / length)


def dot(v1, v2):
    return v1[0] * v2[0] + v1[1] * v2[1] + v1[2] * v2[2]


def angle_between(n1, n2):
    """两法向量夹角（弧度），值域 [0, pi]"""
    d = max(-1.0, min(1.0, dot(n1, n2)))
    return math.acos(d)


def build_edge_face_map(faces):
    """构建边→邻接面 映射。key=(min_vi, max_vi), value=[face_idx, ...]"""
    ef = {}
    for fi, (v0, v1, v2) in enumerate(faces):
        for a, b in [(v0, v1), (v1, v2), (v2, v0)]:
            key = (min(a, b), max(a, b))
            ef.setdefault(key, []).append(fi)
    return ef


def extract_sharp_edges(vertices, faces, angle_threshold_deg):
    """
    提取尖锐边缘。
    返回:
      sharp_edges: [(v0, v1), ...]
      stats: {boundary_count, dihedral_count, total}
    """
    threshold_rad = math.radians(angle_threshold_deg)
    edge_faces = build_edge_face_map(faces)

    # 预计算所有面法向量
    face_normals = []
    for v0, v1, v2 in faces:
        n = compute_normal(vertices[v0], vertices[v1], vertices[v2])
        face_normals.append(n)

    sharp_edges = []
    boundary_cnt = 0
    dihedral_cnt = 0

    for edge, adj in edge_faces.items():
        if len(adj) == 1:
            sharp_edges.append(edge)
            boundary_cnt += 1
        elif len(adj) >= 2:
            is_sharp = False
            for i in range(len(adj)):
                for j in range(i + 1, len(adj)):
                    ang = angle_between(face_normals[adj[i]], face_normals[adj[j]])
                    if ang >= threshold_rad:
                        is_sharp = True
                        break
                if is_sharp:
                    break
            if is_sharp:
                sharp_edges.append(edge)
                dihedral_cnt += 1

    return sharp_edges, {
        'boundary_count': boundary_cnt,
        'dihedral_count': dihedral_cnt,
        'total': len(sharp_edges),
    }


def sample_edge_points(v_start, v_end, density, min_pts):
    """沿线段均匀采样"""
    dx, dy, dz = v_end[0] - v_start[0], v_end[1] - v_start[1], v_end[2] - v_start[2]
    length = math.sqrt(dx * dx + dy * dy + dz * dz)
    n = max(min_pts, int(math.ceil(length * density)))
    pts = []
    for i in range(n):
        t = 0.5 if n == 1 else i / (n - 1)
        pts.append((v_start[0] + t * dx, v_start[1] + t * dy, v_start[2] + t * dz))
    return pts


def compute_bbox(vertices):
    """包围盒"""
    if not vertices:
        return None
    xs, ys, zs = [v[0] for v in vertices], [v[1] for v in vertices], [v[2] for v in vertices]
    return {
        'min': [min(xs), min(ys), min(zs)],
        'max': [max(xs), max(ys), max(zs)],
        'center': [(min(xs) + max(xs)) / 2, (min(ys) + max(ys)) / 2, (min(zs) + max(zs)) / 2],
        'size': [max(xs) - min(xs), max(ys) - min(ys), max(zs) - min(zs)],
    }


def allowed_file(filename):
    return '.' in filename and filename.rsplit('.', 1)[1].lower() in ALLOWED_EXTENSIONS


# ============================================================
# API 路由
# ============================================================

@app.route('/')
def index():
    return render_template('index.html')


@app.route('/api/upload', methods=['POST'])
def upload():
    """上传 OBJ 文件，返回 session_id"""
    if 'file' not in request.files:
        return jsonify({'success': False, 'error': '未找到上传文件'}), 400

    file = request.files['file']
    if not file.filename or not allowed_file(file.filename):
        return jsonify({'success': False, 'error': '仅支持 .obj 文件'}), 400

    sid = str(uuid.uuid4())[:12]
    sdir = UPLOAD_FOLDER / sid
    sdir.mkdir(exist_ok=True)

    fname = secure_filename(file.filename)
    obj_path = sdir / fname
    file.save(str(obj_path))

    try:
        verts, faces = parse_obj(str(obj_path))
        bbox = compute_bbox(verts)
    except Exception as e:
        shutil.rmtree(sdir, ignore_errors=True)
        return jsonify({'success': False, 'error': f'OBJ 解析失败: {e}'}), 400

    if not faces:
        shutil.rmtree(sdir, ignore_errors=True)
        return jsonify({'success': False, 'error': 'OBJ 文件中没有面数据'}), 400

    sessions[sid] = {
        'obj_path': str(obj_path),
        'filename': fname,
        'vertices': verts,
        'faces': faces,
        'bbox': bbox,
    }

    return jsonify({
        'success': True,
        'session_id': sid,
        'filename': fname,
        'vertex_count': len(verts),
        'face_count': len(faces),
        'bbox': bbox,
    })


@app.route('/api/extract', methods=['POST'])
def extract():
    """执行边缘提取"""
    data = request.get_json(silent=True) or {}
    sid = data.get('session_id')

    if not sid or sid not in sessions:
        return jsonify({'success': False, 'error': '无效会话，请重新上传文件'}), 400

    sess = sessions[sid]
    angle = float(data.get('angle_threshold', 25.0))
    density = float(data.get('sample_density', 50.0))
    min_pts = int(data.get('min_samples', 2))

    if not (0 < angle <= 180):
        return jsonify({'success': False, 'error': '二面角阈值需在 0~180° 之间'}), 400
    if not (0 < density <= 1000):
        return jsonify({'success': False, 'error': '采样密度需在 0~1000 之间'}), 400
    if not (1 <= min_pts <= 100):
        return jsonify({'success': False, 'error': '最小采样点数需在 1~100 之间'}), 400

    verts, faces = sess['vertices'], sess['faces']

    try:
        sharp_edges, estats = extract_sharp_edges(verts, faces, angle)

        all_pts = []
        segs = []
        for v0i, v1i in sharp_edges:
            v0, v1 = verts[v0i], verts[v1i]
            all_pts.extend(sample_edge_points(v0, v1, density, min_pts))
            segs.append({'start': list(v0), 'end': list(v1)})

        # 写输出文件
        base = Path(sess['filename']).stem
        out_dir = OUTPUT_FOLDER / sid
        out_dir.mkdir(exist_ok=True)

        ply_path = out_dir / f'{base}_edge_gt.ply'
        with open(ply_path, 'w') as f:
            f.write('ply\nformat ascii 1.0\n')
            f.write(f'element vertex {len(all_pts)}\n')
            f.write('property float x\nproperty float y\nproperty float z\n')
            f.write('end_header\n')
            for p in all_pts:
                f.write(f'{p[0]:.6f} {p[1]:.6f} {p[2]:.6f}\n')

        seg_path = out_dir / f'{base}_edge_segments.txt'
        with open(seg_path, 'w') as f:
            f.write('# edge_id x1 y1 z1 x2 y2 z2\n')
            for i, (v0i, v1i) in enumerate(sharp_edges):
                v0, v1 = verts[v0i], verts[v1i]
                f.write(f'{i} {v0[0]:.6f} {v0[1]:.6f} {v0[2]:.6f} '
                        f'{v1[0]:.6f} {v1[1]:.6f} {v1[2]:.6f}\n')

        sess.update({
            'ply_path': str(ply_path),
            'seg_path': str(seg_path),
            'edge_segments': segs,
            'params': {'angle_threshold': angle, 'sample_density': density, 'min_samples': min_pts},
        })

        return jsonify({
            'success': True,
            'session_id': sid,
            'stats': {
                'vertex_count': len(verts),
                'face_count': len(faces),
                'sharp_edge_count': estats['total'],
                'boundary_count': estats['boundary_count'],
                'dihedral_count': estats['dihedral_count'],
                'edge_point_count': len(all_pts),
            },
            'params': sess['params'],
            'bbox': sess['bbox'],
            'mesh_data': {
                'vertices': [[v[0], v[1], v[2]] for v in verts],
                'faces': [[f[0], f[1], f[2]] for f in faces],
            },
            'edge_data': {
                'points': [[p[0], p[1], p[2]] for p in all_pts],
                'segments': segs,
            },
        })

    except Exception as e:
        return jsonify({'success': False, 'error': f'提取失败: {e}'}), 500


@app.route('/api/download/<sid>/<ftype>')
def download(sid, ftype):
    """下载结果文件 (ply / txt)"""
    if sid not in sessions:
        return jsonify({'success': False, 'error': '无效会话'}), 404

    sess = sessions[sid]
    key = {'ply': 'ply_path', 'txt': 'seg_path'}.get(ftype)
    if not key:
        return jsonify({'success': False, 'error': f'不支持的类型: {ftype}'}), 400

    path = sess.get(key)
    if not path or not os.path.exists(path):
        return jsonify({'success': False, 'error': '文件不存在，请先提取边缘'}), 404

    base = Path(sess['filename']).stem
    dname = f'{base}_edge_gt.ply' if ftype == 'ply' else f'{base}_edge_segments.txt'
    return send_file(path, as_attachment=True, download_name=dname)


@app.route('/api/health')
def health():
    return jsonify({'status': 'ok'})


# ============================================================
# 启动入口
# ============================================================

if __name__ == '__main__':
    print('=' * 60)
    print('  点云边缘真值提取平台')
    print('  Ground Truth Edge Extraction Platform')
    print('=' * 60)
    print()
    print('  访问地址: http://localhost:5000')
    print()
    app.run(host='0.0.0.0', port=5000, debug=True)
