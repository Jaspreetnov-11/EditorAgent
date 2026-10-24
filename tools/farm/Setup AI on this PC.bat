@echo off
title Limelight - AI on this PC
rem Once, on a helper PC with an NVIDIA card: Python + Whisper (transcribing) + PyTorch on the GPU (AI cut-outs) + OpenCV
rem (tracking) + the Agent's vision model (SigLIP: shot size, beauty, rejects, Hindi / English shot matching), so this PC
rem can do the editor's AI work. The models come from the NAS folder "AI models" next to this file and are copied to
rem %LOCALAPPDATA%\Limelight\AI (the editor's code looks there). The local AI (Qwen + llama.cpp) is optional.
rem Then close and start "Start Render Worker.bat" again - its window lists what it does.

where nvidia-smi >nul 2>nul || (
  echo Is PC mein NVIDIA card nahi mila - AI ka kaam sirf NVIDIA wale PC pe hota hai.
  pause & exit /b
)
where python >nul 2>nul || (
  echo Python nahi mila - install kar raha hoon...
  winget install -e --id Python.Python.3.12 --accept-package-agreements --accept-source-agreements
  echo Install ho gaya. Is window ko band karke file dobara double-click karo.
  pause & exit /b
)
echo AI libraries install ho rahi hain (kuch GB, thoda time lagega)...
python -m pip install --upgrade pip
python -m pip install faster-whisper nvidia-cublas-cu12 nvidia-cudnn-cu12 nvidia-cuda-nvrtc-cu12 opencv-python numpy
python -m pip install torch torchvision --index-url https://download.pytorch.org/whl/cu124
python -m pip install transformers sentencepiece protobuf safetensors easyocr

set "SRC=%~dp0AI models"
set "DST=%LOCALAPPDATA%\Limelight\AI"
if not exist "%SRC%\hf" (
  echo "AI models" folder NAS pe nahi mila - Agent ka vision model copy nahi hua.
  goto check
)
echo Agent ka vision model copy ho raha hai (1.4 GB)...
robocopy "%SRC%\hf" "%DST%\hf" /E /NFL /NDL /NJH /NJS /NP /R:2 /W:2 >nul

echo.
choice /C YN /M "Local AI (Qwen, 5.5 GB - sirf 8 GB ya zyada wale NVIDIA card ke liye) bhi copy karun"
if errorlevel 2 goto check
echo Local AI copy ho raha hai (5.5 GB)...
robocopy "%SRC%\llama" "%DST%\llama" /E /NFL /NDL /NJH /NJS /NP /R:2 /W:2 >nul
robocopy "%SRC%\llm" "%DST%\llm" /E /NFL /NDL /NJH /NJS /NP /R:2 /W:2 >nul

:check
echo.
python -c "import faster_whisper, ctranslate2; n = ctranslate2.get_cuda_device_count(); print('Whisper GPU: ' + ('haan' if n else 'nahi'))"
python -c "import torch, cv2; print('PyTorch GPU: ' + ('haan' if torch.cuda.is_available() else 'nahi') + ', OpenCV: haan')"
python -c "import transformers, easyocr, os; h = os.path.join(os.environ['LOCALAPPDATA'], 'Limelight', 'AI', 'hf', 'hub'); print('Agent vision model: ' + ('haan' if os.path.isdir(h) else 'nahi'))"
if exist "%DST%\llm\Qwen2.5-7B-Instruct-Q4_K_M.gguf" (echo Local AI: haan) else (echo Local AI: nahi)
echo.
echo Ho gaya. Ab "Start Render Worker.bat" ki window band karke dobara chalao.
pause
