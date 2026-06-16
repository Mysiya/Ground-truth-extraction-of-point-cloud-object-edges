@echo off
chcp 65001 >/dev/null
echo ============================================================
echo   点云边缘真值提取平台 - 安装与启动
echo   Ground Truth Edge Extraction Platform
echo ============================================================
echo.

python --version >/dev/null 2>&1
if %errorlevel% neq 0 (
    echo [错误] 未找到 Python，请先安装 Python 3.7+
    echo 下载地址: https://www.python.org/downloads/
    pause
    exit /b 1
)
echo [✓] Python 已检测到

if not exist "venv\" (
    echo [*] 创建虚拟环境...
    python -m venv venv
)

echo [*] 激活虚拟环境...
call venv\Scripts\activate.bat

echo [*] 安装依赖...
pip install -r requirements.txt -q

if not exist "uploads\" mkdir uploads
if not exist "outputs\" mkdir outputs

echo.
echo ============================================================
echo   启动服务器...
echo   访问地址: http://localhost:5000
echo   按 Ctrl+C 停止服务器
echo ============================================================
echo.

python app.py
pause
