# Write the Windows launcher as GBK so cmd.exe (codepage 936) parses the
# Chinese text correctly. A UTF-8 .cmd gets mis-decoded and breaks the script.
import io
import os

ROOT = r"D:\Documents\deepseek-harness\default-workspace\legado-ios"
OUT = os.path.join(ROOT, "启动阅读服务.cmd")

CMD = r"""@echo off
setlocal EnableDelayedExpansion
title 阅读 - Legado iPad 服务

set "NODE_EXE="
for /f "delims=" %%i in ('where node 2^>nul') do (
    if not defined NODE_EXE set "NODE_EXE=%%i"
)
if not defined NODE_EXE (
    set "BUNDLED=%USERPROFILE%\.dsh\dsh-runtimes\dsh-next-primary-runtime\dependencies\node\bin\node.exe"
    if exist "!BUNDLED!" set "NODE_EXE=!BUNDLED!"
)
if not defined NODE_EXE (
    echo.
    echo   找不到 Node.js。
    echo   请先安装 https://nodejs.org/ 选 LTS 版本即可
    echo.
    pause
    exit /b 1
)

set "HERE=%~dp0"
set "SERVER=%HERE%server\webservice.mjs"
if not exist "%SERVER%" (
    echo   找不到 %SERVER%
    pause
    exit /b 1
)

if not exist "%HERE%server\data\db.json" (
    echo   首次运行，正在初始化书源数据...
    "%NODE_EXE%" "%HERE%scripts\seed.mjs"
)

echo.
echo   ============================================================
echo     阅读 - Legado  iPad 服务
echo   ============================================================
echo.
"%NODE_EXE%" "%HERE%scripts\lan-url.mjs"
echo.
echo   在 iPad 的 Safari 里打开上面任意一个地址。
echo   打开后点 分享 - 添加到主屏幕，以后就像 App 一样用。
echo.
echo   保持这个窗口开着。关闭窗口 = 服务停止。
echo   如果 Windows 弹出防火墙提示，请选 允许访问。
echo.
echo   ============================================================
echo.

set "LEGADO_PORT=1234"
"%NODE_EXE%" "%SERVER%"

echo.
echo   服务已停止。
pause
"""

with io.open(OUT, "w", encoding="gbk", newline="\r\n") as f:
    f.write(CMD)
print("wrote", OUT, os.path.getsize(OUT), "bytes (GBK)")
