@echo off
rem 恢复指针:复制粘贴 chill 目录导致 junction 断链后,双击本文件即可修复
rem 逻辑:指针健康则报告退出;断链则固化当前 chill 为新版本、重建 junction、校正指针并构建
chcp 65001 >nul
node "%~dp0freeze.js" --repair --build
pause
