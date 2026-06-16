#!/usr/bin/env bash
set -e

echo "============================================================"
echo "  点云边缘真值提取平台 - 安装与启动"
echo "  Ground Truth Edge Extraction Platform"
echo "============================================================"
echo ""

if ! command -v python3 &>/dev/null; then
    echo "[错误] 未找到 Python3，请先安装 Python 3.7+"
    exit 1
fi
echo "[✓] Python3 已检测到"

if [ ! -d "venv" ]; then
    echo "[*] 创建虚拟环境..."
    python3 -m venv venv
fi

echo "[*] 激活虚拟环境..."
source venv/bin/activate

echo "[*] 安装依赖..."
pip install -r requirements.txt -q

mkdir -p uploads outputs

echo ""
echo "============================================================"
echo "  启动服务器..."
echo "  访问地址: http://localhost:5000"
echo "  按 Ctrl+C 停止服务器"
echo "============================================================"
echo ""

python app.py
