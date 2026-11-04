import fs from 'fs';

console.log('Reading main.js...');
let code = fs.readFileSync('main.js', 'utf8');
const initialLength = code.length;

// 1. Expose global.__nativelyAppState
const appStateTarget = 'const appState = AppState.getInstance();';
if (!code.includes(appStateTarget)) {
  throw new Error('Target appStateTarget not found');
}
if (!code.includes('global.__nativelyAppState = appState;')) {
  code = code.replace(
    appStateTarget,
    `${appStateTarget}\n  global.__nativelyAppState = appState;`
  );
  console.log('Added global.__nativelyAppState hook.');
} else {
  console.log('global.__nativelyAppState already present.');
}

// 2. Add /screenshot-full and /upload-crop HTTP endpoints in handleHttp
const httpTarget = 'if (fullUrl.pathname !== "/" && fullUrl.pathname !== "/index.html") {';
if (!code.includes(httpTarget)) {
  throw new Error('Target httpTarget not found');
}

const endpointsCode = `
        if (fullUrl.pathname === "/screenshot-full") {
          if (req.method !== "GET") {
            res.writeHead(405, { "Content-Type": "text/plain" });
            res.end("Method Not Allowed");
            return;
          }
          if (!provided || !timingSafeEqualStr(provided, this.token)) {
            res.writeHead(401, { "Content-Type": "text/plain" });
            res.end("Pairing token missing or invalid.");
            return;
          }
          (async () => {
            try {
              const electronModule = import_electron26 || require("electron");
              const targetDisplay = electronModule.screen.getPrimaryDisplay();
              const { width, height } = targetDisplay.bounds;
              const sources = await electronModule.desktopCapturer.getSources({
                types: ["screen"],
                thumbnailSize: { width, height }
              });
              const targetDisplayId = targetDisplay.id.toString();
              let matchedSource = sources.find(s => s.display_id === targetDisplayId) || sources[0];
              if (!matchedSource) throw new Error("No screen capture source found");
              const jpegBuf = matchedSource.thumbnail.toJPEG(85);
              res.writeHead(200, {
                "Content-Type": "image/jpeg",
                "Content-Length": String(jpegBuf.length),
                "Cache-Control": "no-store",
                "X-Screen-Width": String(width),
                "X-Screen-Height": String(height)
              });
              res.end(jpegBuf);
            } catch (err) {
              console.error("[PhoneMirror] /screenshot-full capture error:", err);
              res.writeHead(500, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ error: err ? err.message : "capture_failed" }));
            }
          })();
          return;
        }

        if (fullUrl.pathname === "/upload-crop") {
          if (req.method !== "POST") {
            res.writeHead(405, { "Content-Type": "text/plain" });
            res.end("Method Not Allowed");
            return;
          }
          if (!provided || !timingSafeEqualStr(provided, this.token)) {
            res.writeHead(401, { "Content-Type": "text/plain" });
            res.end("Pairing token missing or invalid.");
            return;
          }
          const chunks = [];
          let totalLen = 0;
          req.on("data", (chunk) => {
            chunks.push(chunk);
            totalLen += chunk.length;
            if (totalLen > 15 * 1024 * 1024) {
              res.writeHead(413, { "Content-Type": "text/plain" });
              res.end("Payload Too Large");
              req.socket.destroy();
            }
          });
          req.on("end", async () => {
            try {
              const fullBuffer = Buffer.concat(chunks, totalLen);
              const promptHeader = decodeURIComponent(req.headers["x-crop-prompt"] || "");
              const appSt = global.__nativelyAppState;
              if (!appSt) throw new Error("AppState not ready");
              const fsMod = import_node_fs5 ? (import_node_fs5.default || import_node_fs5) : require("fs");
              const pathMod = import_node_path5 ? (import_node_path5.default || import_node_path5) : require("path");
              const helper = appSt.getScreenshotHelper();
              const saveDir = helper.screenshotDir;
              const fileName = "crop_" + Date.now() + "_" + Math.random().toString(36).slice(2, 8) + ".jpg";
              const savePath = pathMod.join(saveDir, fileName);
              await fsMod.promises.writeFile(savePath, fullBuffer);

              helper.screenshotQueue.push(savePath);
              if (helper.screenshotQueue.length > helper.MAX_SCREENSHOTS) {
                const old = helper.screenshotQueue.shift();
                if (old) { try { await fsMod.promises.unlink(old); } catch (_) {} }
              }

              this.publishAck("screenshot", "Cropped screenshot queued for AI");

              if (promptHeader) {
                console.log("[PhoneMirror] Triggering question with crop:", promptHeader);
                const win = appSt.getMainWindow();
                if (win && !win.isDestroyed()) {
                  win.webContents.send("phone-mirror:incoming-chat", {
                    message: promptHeader,
                    screenshotPath: savePath
                  });
                }
              }

              res.writeHead(200, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ ok: true, path: savePath }));
            } catch (err) {
              console.error("[PhoneMirror] /upload-crop error:", err);
              res.writeHead(500, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ error: err ? err.message : "upload_failed" }));
            }
          });
          return;
        }
`;

if (!code.includes('fullUrl.pathname === "/screenshot-full"')) {
  code = code.replace(httpTarget, `${endpointsCode}\n        ${httpTarget}`);
  console.log('Added /screenshot-full and /upload-crop HTTP endpoints.');
} else {
  console.log('/screenshot-full already present in handleHttp.');
}

// 3. Add Crop Button in HTML
const captureBtnTarget = '<button class="qa-btn screenshot-btn" id="screenshotBtn" type="button" title="Capture desktop screenshot for AI prompt">\\u{1F4F7} Capture</button>';
const cropButtonHtml = `\n          <button class="qa-btn crop-btn" id="cropBtn" type="button" title="Capture and crop area of screen">\\u{2702} Crop Screen</button>`;

if (!code.includes('id="cropBtn"')) {
  code = code.replace(captureBtnTarget, `${captureBtnTarget}${cropButtonHtml}`);
  console.log('Added #cropBtn button to HTML.');
} else {
  console.log('#cropBtn already present.');
}

// 4. Add Cropper Modal HTML
const toastTarget = '<div class="toast" id="toast" role="status"></div>';
const cropperModalHtml = `
      <div class="cropper-modal" id="cropperModal" hidden role="dialog" aria-modal="true" aria-label="Crop full screen screenshot">
        <header class="cropper-header">
          <button class="cropper-hdr-btn" id="cropperCancel" type="button">Cancel</button>
          <div class="cropper-title">Crop Screen & Ask AI</div>
          <button class="cropper-hdr-btn is-action" id="cropperReset" type="button">Reset</button>
        </header>
        <div class="cropper-stage" id="cropperStage">
          <div class="cropper-canvas-wrap" id="cropperCanvasWrap">
            <canvas id="cropperCanvas"></canvas>
            <div class="cropper-box" id="cropperBox">
              <div class="cropper-handle handle-nw" data-handle="nw"></div>
              <div class="cropper-handle handle-ne" data-handle="ne"></div>
              <div class="cropper-handle handle-sw" data-handle="sw"></div>
              <div class="cropper-handle handle-se" data-handle="se"></div>
            </div>
          </div>
        </div>
        <footer class="cropper-footer">
          <div class="cropper-composer">
            <input class="cropper-prompt" id="cropperPrompt" type="text" placeholder="What should AI answer? (optional)" maxlength="200" />
            <button class="cropper-send-btn" id="cropperSend" type="button">
              <span>Ask AI</span>
            </button>
          </div>
        </footer>
      </div>
`;

if (!code.includes('id="cropperModal"')) {
  code = code.replace(toastTarget, `${cropperModalHtml}\n      ${toastTarget}`);
  console.log('Added #cropperModal markup to HTML.');
} else {
  console.log('#cropperModal already present.');
}

// 5. Add Cropper CSS
const cssTarget = '.qa-btn.screenshot-btn {';
const cropperCss = `
      .qa-btn.crop-btn {
        color: #6cf0d6; border-color: rgba(108,240,214,0.38);
        background: rgba(108,240,214,0.08); font-weight: 600;
      }
      .cropper-modal {
        position: fixed; inset: 0; z-index: 1000;
        background: #0d1117; display: flex; flex-direction: column;
        user-select: none; -webkit-user-select: none;
      }
      .cropper-modal[hidden] { display: none !important; }
      .cropper-header {
        height: 52px; display: flex; align-items: center; justify-content: space-between;
        padding: 0 16px; border-bottom: 1px solid rgba(255,255,255,0.1); background: #161b22;
      }
      .cropper-title { font-weight: 600; font-size: 15px; color: #f0f6fc; }
      .cropper-hdr-btn {
        background: none; border: none; color: #8b949e; font-size: 14px; font-weight: 500; padding: 8px 12px; cursor: pointer;
      }
      .cropper-hdr-btn.is-action { color: #58a6ff; font-weight: 600; }
      .cropper-stage {
        flex: 1; position: relative; overflow: hidden; display: flex;
        align-items: center; justify-content: center; background: #010409; touch-action: none;
      }
      .cropper-canvas-wrap { position: relative; display: inline-block; }
      #cropperCanvas { display: block; max-width: 100%; max-height: 100%; }
      .cropper-box {
        position: absolute; border: 2px solid #58a6ff;
        background: rgba(88,166,255,0.18); box-shadow: 0 0 0 9999px rgba(0,0,0,0.65);
        cursor: move; touch-action: none; box-sizing: border-box;
      }
      .cropper-handle {
        position: absolute; width: 24px; height: 24px; background: #58a6ff;
        border: 2px solid #ffffff; border-radius: 50%; box-shadow: 0 2px 6px rgba(0,0,0,0.4);
      }
      .cropper-handle.handle-nw { top: -12px; left: -12px; cursor: nwse-resize; }
      .cropper-handle.handle-ne { top: -12px; right: -12px; cursor: nesw-resize; }
      .cropper-handle.handle-sw { bottom: -12px; left: -12px; cursor: nesw-resize; }
      .cropper-handle.handle-se { bottom: -12px; right: -12px; cursor: nwse-resize; }
      .cropper-footer {
        padding: 12px 16px calc(12px + env(safe-area-inset-bottom, 0px));
        background: #161b22; border-top: 1px solid rgba(255,255,255,0.1);
      }
      .cropper-composer { display: flex; gap: 8px; }
      .cropper-prompt {
        flex: 1; height: 42px; background: #0d1117; border: 1px solid rgba(255,255,255,0.15);
        border-radius: 8px; padding: 0 12px; color: #f0f6fc; font-size: 14px; outline: none;
      }
      .cropper-send-btn {
        height: 42px; padding: 0 18px; background: #238636; border: none;
        border-radius: 8px; color: #fff; font-weight: 600; font-size: 14px; cursor: pointer;
      }
`;

if (!code.includes('.qa-btn.crop-btn')) {
  code = code.replace(cssTarget, `${cropperCss}\n      ${cssTarget}`);
  console.log('Added Cropper CSS styles.');
} else {
  console.log('Cropper CSS already present.');
}

// 6. Add Cropper JavaScript Client logic
const jsTarget = "document.getElementById('screenshotBtn').addEventListener('click'";
const cropperJs = `
        // ─── Crop & Screen Capture Logic ───
        var cropperModal = document.getElementById('cropperModal');
        var cropperCanvas = document.getElementById('cropperCanvas');
        var cropperCanvasWrap = document.getElementById('cropperCanvasWrap');
        var cropperBox = document.getElementById('cropperBox');
        var cropperPrompt = document.getElementById('cropperPrompt');
        var cropperSend = document.getElementById('cropperSend');
        var cropperCancel = document.getElementById('cropperCancel');
        var cropperReset = document.getElementById('cropperReset');
        var cropBtn = document.getElementById('cropBtn');

        var cropperSourceImage = null;
        var cropDrag = null;
        var cropBoxRect = { x: 0, y: 0, w: 0, h: 0 };

        function closeCropperModal() {
          if (cropperModal) cropperModal.hidden = true;
          cropperSourceImage = null;
          cropDrag = null;
        }

        if (cropperCancel) cropperCancel.addEventListener('click', closeCropperModal);
        if (cropperReset) cropperReset.addEventListener('click', function () {
          if (!cropperCanvas.width || !cropperCanvas.height) return;
          var cw = cropperCanvas.clientWidth;
          var ch = cropperCanvas.clientHeight;
          var bw = Math.round(cw * 0.75);
          var bh = Math.round(ch * 0.6);
          cropBoxRect = { x: Math.round((cw - bw) / 2), y: Math.round((ch - bh) / 2), w: bw, h: bh };
          renderCropBox();
        });

        function renderCropBox() {
          if (!cropperBox) return;
          cropperBox.style.left = cropBoxRect.x + 'px';
          cropperBox.style.top = cropBoxRect.y + 'px';
          cropperBox.style.width = cropBoxRect.w + 'px';
          cropperBox.style.height = cropBoxRect.h + 'px';
        }

        function initCropperWithImage(img) {
          cropperSourceImage = img;
          var stage = document.getElementById('cropperStage');
          var stageW = stage ? stage.clientWidth : window.innerWidth;
          var stageH = stage ? stage.clientHeight : (window.innerHeight - 130);
          var naturalW = img.naturalWidth || img.width;
          var naturalH = img.naturalHeight || img.height;
          var fitScale = Math.min((stageW - 24) / naturalW, (stageH - 24) / naturalH, 1);
          var dispW = Math.max(100, Math.round(naturalW * fitScale));
          var dispH = Math.max(80, Math.round(naturalH * fitScale));

          cropperCanvas.width = naturalW;
          cropperCanvas.height = naturalH;
          cropperCanvas.style.width = dispW + 'px';
          cropperCanvas.style.height = dispH + 'px';

          var ctx = cropperCanvas.getContext('2d');
          ctx.drawImage(img, 0, 0, naturalW, naturalH);

          var bw = Math.round(dispW * 0.75);
          var bh = Math.round(dispH * 0.6);
          cropBoxRect = { x: Math.round((dispW - bw) / 2), y: Math.round((dispH - bh) / 2), w: bw, h: bh };
          renderCropBox();
          cropperModal.hidden = false;
          if (cropperPrompt) cropperPrompt.value = '';
        }

        if (cropBtn) cropBtn.addEventListener('click', function () {
          showToast('Capturing computer screen\\u2026');
          fetch('/screenshot-full?t=' + encodeURIComponent(token), { cache: 'no-store' })
            .then(function (res) {
              if (!res.ok) throw new Error('capture-failed: ' + res.status);
              return res.blob();
            })
            .then(function (blob) {
              return new Promise(function (resolve, reject) {
                var img = new Image();
                var u = URL.createObjectURL(blob);
                img.onload = function () { URL.revokeObjectURL(u); resolve(img); };
                img.onerror = function (e) { URL.revokeObjectURL(u); reject(e); };
                img.src = u;
              });
            })
            .then(function (img) {
              initCropperWithImage(img);
            })
            .catch(function (err) {
              showToast('Capture error: ' + (err ? err.message : 'failed'));
            });
        });

        function onPointerDown(e) {
          var handle = e.target && e.target.dataset && e.target.dataset.handle;
          var mode = handle ? handle : (e.target === cropperBox ? 'move' : null);
          if (!mode) return;
          e.preventDefault();
          cropDrag = {
            mode: mode,
            startX: e.clientX,
            startY: e.clientY,
            initBox: { x: cropBoxRect.x, y: cropBoxRect.y, w: cropBoxRect.w, h: cropBoxRect.h }
          };
          try { e.target.setPointerCapture(e.pointerId); } catch (_) {}
        }

        function onPointerMove(e) {
          if (!cropDrag) return;
          e.preventDefault();
          var dx = e.clientX - cropDrag.startX;
          var dy = e.clientY - cropDrag.startY;
          var b = cropDrag.initBox;
          var maxW = cropperCanvas.clientWidth;
          var maxH = cropperCanvas.clientHeight;
          var minSize = 30;

          var nx = b.x; var ny = b.y; var nw = b.w; var nh = b.h;
          if (cropDrag.mode === 'move') {
            nx = Math.max(0, Math.min(maxW - b.w, b.x + dx));
            ny = Math.max(0, Math.min(maxH - b.h, b.y + dy));
          } else if (cropDrag.mode === 'nw') {
            var right = b.x + b.w; var bottom = b.y + b.h;
            nx = Math.max(0, Math.min(right - minSize, b.x + dx));
            ny = Math.max(0, Math.min(bottom - minSize, b.y + dy));
            nw = right - nx; nh = bottom - ny;
          } else if (cropDrag.mode === 'ne') {
            var bottomNe = b.y + b.h;
            ny = Math.max(0, Math.min(bottomNe - minSize, b.y + dy));
            nw = Math.max(minSize, Math.min(maxW - b.x, b.w + dx));
            nh = bottomNe - ny;
          } else if (cropDrag.mode === 'sw') {
            var rightSw = b.x + b.w;
            nx = Math.max(0, Math.min(rightSw - minSize, b.x + dx));
            nw = rightSw - nx;
            nh = Math.max(minSize, Math.min(maxH - b.y, b.h + dy));
          } else if (cropDrag.mode === 'se') {
            nw = Math.max(minSize, Math.min(maxW - b.x, b.w + dx));
            nh = Math.max(minSize, Math.min(maxH - b.y, b.h + dy));
          }
          cropBoxRect = { x: nx, y: ny, w: nw, h: nh };
          renderCropBox();
        }

        function onPointerUp(e) {
          if (!cropDrag) return;
          cropDrag = null;
        }

        if (cropperBox) cropperBox.addEventListener('pointerdown', onPointerDown);
        if (cropperCanvasWrap) cropperCanvasWrap.addEventListener('pointermove', onPointerMove);
        window.addEventListener('pointerup', onPointerUp);
        window.addEventListener('pointercancel', onPointerUp);

        if (cropperSend) cropperSend.addEventListener('click', function () {
          if (!cropperSourceImage) return;
          var promptText = (cropperPrompt ? cropperPrompt.value : '').trim();
          var cw = cropperCanvas.clientWidth;
          var ch = cropperCanvas.clientHeight;
          var nw = cropperSourceImage.naturalWidth || cropperSourceImage.width;
          var nh = cropperSourceImage.naturalHeight || cropperSourceImage.height;
          var scaleX = nw / cw;
          var scaleY = nh / ch;

          var srcX = Math.max(0, Math.round(cropBoxRect.x * scaleX));
          var srcY = Math.max(0, Math.round(cropBoxRect.y * scaleY));
          var srcW = Math.min(nw - srcX, Math.round(cropBoxRect.w * scaleX));
          var srcH = Math.min(nh - srcY, Math.round(cropBoxRect.h * scaleY));

          if (srcW <= 0 || srcH <= 0) {
            showToast('Please select an area');
            return;
          }

          var cropCanvas = document.createElement('canvas');
          cropCanvas.width = srcW;
          cropCanvas.height = srcH;
          var ctx = cropCanvas.getContext('2d');
          ctx.drawImage(cropperSourceImage, srcX, srcY, srcW, srcH, 0, 0, srcW, srcH);

          cropCanvas.toBlob(function (blob) {
            if (!blob) { showToast('Could not process crop'); return; }
            closeCropperModal();
            showToast('Uploading cropped area to desktop\\u2026');

            fetch('/upload-crop?t=' + encodeURIComponent(token), {
              method: 'POST',
              headers: {
                'Content-Type': 'image/jpeg',
                'X-Crop-Prompt': encodeURIComponent(promptText)
              },
              body: blob
            })
            .then(function (res) {
              if (!res.ok) throw new Error('upload failed: ' + res.status);
              return res.json();
            })
            .then(function () {
              showToast('Cropped image sent! AI responding...');
              if (!promptText) {
                sendCommand({ type: 'action', action: 'whatToAnswer' });
              }
            })
            .catch(function (err) {
              showToast('Upload error: ' + (err ? err.message : 'failed'));
            });
          }, 'image/jpeg', 0.88);
        });
`;

if (!code.includes('closeCropperModal()')) {
  code = code.replace(jsTarget, `${cropperJs}\n        ${jsTarget}`);
  console.log('Added Cropper JS handlers.');
} else {
  console.log('Cropper JS handlers already present.');
}

fs.writeFileSync('main.js', code, 'utf8');
console.log('Successfully updated main.js! Length:', initialLength, '->', code.length);
