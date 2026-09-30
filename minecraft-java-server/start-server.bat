@echo off
cd /d "%~dp0"

set "JAVA_EXE=%LOCALAPPDATA%\Programs\Eclipse Adoptium\jdk-25.0.4.1+1\bin\java.exe"

"%JAVA_EXE%" -Xms4G -Xmx10G -jar server.jar nogui
pause
