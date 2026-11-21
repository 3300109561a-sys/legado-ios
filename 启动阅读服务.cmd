@echo off
setlocal EnableDelayedExpansion
title �Ķ� - Legado iPad ����

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
    echo   �Ҳ��� Node.js��
    echo   ���Ȱ�װ https://nodejs.org/ ѡ LTS �汾����
    echo.
    pause
    exit /b 1
)

set "HERE=%~dp0"
set "SERVER=%HERE%server\webservice.mjs"
if not exist "%SERVER%" (
    echo   �Ҳ��� %SERVER%
    pause
    exit /b 1
)

if not exist "%HERE%server\data\db.json" (
    echo   �״����У����ڳ�ʼ����Դ����...
    "%NODE_EXE%" "%HERE%scripts\seed.mjs"
)

echo.
echo   ============================================================
echo     �Ķ� - Legado  iPad ����
echo   ============================================================
echo.
"%NODE_EXE%" "%HERE%scripts\lan-url.mjs"
echo.
echo   �� iPad �� Safari �����������һ����ַ��
echo   �򿪺�� ���� - ���ӵ�����Ļ���Ժ���� App һ���á�
echo.
echo   ����������ڿ��š��رմ��� = ����ֹͣ��
echo   ��� Windows ��������ǽ��ʾ����ѡ �������ʡ�
echo.
echo   ============================================================
echo.

set "LEGADO_PORT=1234"
"%NODE_EXE%" "%SERVER%"

echo.
echo   ������ֹͣ��
pause
