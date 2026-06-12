@echo off
title JADO Simulation - First Time Setup
color 0A
echo.
echo  ================================================================
echo   JADO - Joint All-Domain Operations Simulation
echo   FIRST TIME SETUP  (Internet required this one time only)
echo  ================================================================
echo.

if not exist "lib" mkdir lib

set FAIL=0

echo  [1/6] Downloading Three.js r134 (3D engine)...
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "Invoke-WebRequest -Uri 'https://cdn.jsdelivr.net/npm/three@0.134.0/build/three.min.js' -OutFile 'lib\three.min.js' -UseBasicParsing" 2>nul
if exist "lib\three.min.js" (echo  [OK] three.min.js) else (echo  [FAIL] three.min.js & set FAIL=1)

echo  [2/6] Downloading OrbitControls (camera)...
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "Invoke-WebRequest -Uri 'https://cdn.jsdelivr.net/npm/three@0.134.0/examples/js/controls/OrbitControls.js' -OutFile 'lib\OrbitControls.js' -UseBasicParsing" 2>nul
if exist "lib\OrbitControls.js" (echo  [OK] OrbitControls.js) else (echo  [FAIL] OrbitControls.js & set FAIL=1)

echo  [3/6] Downloading OBJLoader (terrain import)...
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "Invoke-WebRequest -Uri 'https://cdn.jsdelivr.net/npm/three@0.134.0/examples/js/loaders/OBJLoader.js' -OutFile 'lib\OBJLoader.js' -UseBasicParsing" 2>nul
if exist "lib\OBJLoader.js" (echo  [OK] OBJLoader.js) else (echo  [FAIL] OBJLoader.js & set FAIL=1)

echo  [4/6] Downloading STLLoader (STL terrain import)...
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "Invoke-WebRequest -Uri 'https://cdn.jsdelivr.net/npm/three@0.134.0/examples/js/loaders/STLLoader.js' -OutFile 'lib\STLLoader.js' -UseBasicParsing" 2>nul
if exist "lib\STLLoader.js" (echo  [OK] STLLoader.js) else (echo  [FAIL] STLLoader.js & set FAIL=1)

echo  [5/6] Downloading TensorFlow.js 4.10 (DQN RL engine)...
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "Invoke-WebRequest -Uri 'https://cdn.jsdelivr.net/npm/@tensorflow/tfjs@4.10.0/dist/tf.min.js' -OutFile 'lib\tf.min.js' -UseBasicParsing" 2>nul
if exist "lib\tf.min.js" (echo  [OK] tf.min.js) else (echo  [FAIL] tf.min.js & set FAIL=1)

echo  [6/6] Downloading GeoTIFF.js (GeoTIFF/TIF terrain import)...
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "Invoke-WebRequest -Uri 'https://cdn.jsdelivr.net/npm/geotiff@2.1.3/dist-browser/geotiff.js' -OutFile 'lib\geotiff.js' -UseBasicParsing" 2>nul
if exist "lib\geotiff.js" (echo  [OK] geotiff.js) else (echo  [FAIL] geotiff.js & set FAIL=1)

echo.
if %FAIL%==0 (
  color 0A
  echo  ================================================================
  echo   ALL LIBRARIES DOWNLOADED SUCCESSFULLY
  echo   Run run.bat to launch the simulation (no internet needed)
  echo  ================================================================
) else (
  color 0C
  echo  ================================================================
  echo   SOME DOWNLOADS FAILED - Check internet connection and retry
  echo  ================================================================
)
echo.
pause
