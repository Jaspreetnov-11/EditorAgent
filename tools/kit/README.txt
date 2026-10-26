LIMELIGHT KIT - har PC ko poora Limelight PC banana, BINA INTERNET ke
===================================================================

Ek file chalao: "Install Limelight.bat" -> DOUBLE-CLICK (Run as administrator MAT karna - admin window ko NAS
ka Z: drive dikhta hi nahi, isliye woh window khul ke band ho jaati thi). Yeh khud kit ko C:\LimelightKit mein copy
karta hai, AI models seedhe user ke folder mein, phir Windows "Yes / No" poochhega - Yes dabao.
C: pe ~30 GB khaali chahiye (models 20 GB + programs/libraries 4 GB).
Yeh poochhega PC kya hai:
  1 Helper PC      - saare engines; editor ki madad (renders, preview copies, Whisper, AI)
  2 Bridge PC      - helper + standby editor + Limelight Flow + office watch (PC B)
  3 Editor server  - engines, models, app, access (PC A; helper nahi)
  4 Sirf app       - Limelight Editor ki window is PC pe

Kya-kya daalta hai (sab is folder se, internet nahi chahiye):
  programs\   Node.js 24, FFmpeg 9 (NVIDIA encoder ke saath), Python 3.12, OpenSSH
  wheels\     Python ki saari AI libraries (Whisper, PyTorch GPU, OpenCV, CLIP, Demucs, OCR...) - JASPREET jaisi
  models\     Whisper, CLIP, Demucs, voice, Agent ka vision model, local AI (Qwen)
  browser\    Limelight Editor app (Desktop + Start menu pe icon)
  access\     JASPREET ka access (SSH chabi + Remote Desktop, sirf JASPREET ke liye khula)
  helper\     helper (render worker) - Windows chalu hote hi chupchaap chalta hai

Helper ke liye farm token chahiye (editor > Team > Helper PCs, aakhri 24 akshar). Poori line paste karo toh bhi chalega.
Token is folder mein KABHI mat rakhna.

Dobara chalana safe hai - jo pehle se hai woh rehta hai, sirf jo nahi hai woh aata hai.
Jaanch: engine-check.ps1 (har engine ki speed aur accuracy).

JASPREET se (SSH) kisi PC pe: SSH ko bhi NAS nahi dikhta (Access denied) - pehle PC pe "Install Limelight.bat"
ek baar chalao (ya kit scp -O -r se C:\LimelightKit mein copy karo), phir:
  powershell -ExecutionPolicy Bypass -File C:\LimelightKit\install.ps1 -Role helper -Token <token>
