const fs = require('fs');

let content = fs.readFileSync('src/app/scanner/page.tsx', 'utf8');

// 1. Remove Start/Stop button from top bar
const topBarStartBtn = `
            {isScanning ? (
              <button
                onClick={handleStopScanning}
                className="px-4 py-3 sm:py-2 rounded-xl border border-slate-700 bg-slate-900 text-slate-200 text-xs font-black uppercase flex items-center justify-center gap-2 hover:border-red-800 hover:text-red-200"
              >
                <span className="h-2.5 w-2.5 rounded-sm bg-red-500 shadow-[0_0_12px_rgba(239,68,68,0.45)]" />
                <span>{language === 'BM' ? 'Henti Imbasan' : 'Stop Scan'}</span>
              </button>
            ) : (
              <button
                onClick={() => void handleStartScanning()}
                className="px-4 py-3 sm:py-2 rounded-xl bg-cyan-600 hover:bg-cyan-500 text-white text-xs font-black uppercase flex items-center justify-center gap-2 shadow-lg shadow-cyan-500/20"
              >
                <Play className="w-4 h-4" />
                <span>{language === 'BM' ? 'Mula Imbasan' : 'Start Scanning'}</span>
              </button>
            )}`;

content = content.replace(topBarStartBtn, '');

// 2. Simplify Video Source block
const videoSourceBlockStart = `{/* Input Source & Training Video Live Preview Banner */}`;
const videoSourceBlockEnd = `{cameraError && (`;

const videoSourceBlockOld = content.substring(
  content.indexOf(videoSourceBlockStart),
  content.indexOf(videoSourceBlockEnd)
);

const videoSourceBlockNew = `{/* Input Source & Training Video Live Preview Banner */}
      <div className="rounded-2xl border border-cyan-900/40 bg-slate-900/80 p-3 sm:p-4 shadow-xl space-y-3">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-slate-800/80 pb-3">
          <div className="flex items-center gap-2">
            <Film className="w-4 h-4 text-cyan-500" />
            <span className="text-xs font-black uppercase tracking-wider text-slate-200">
              {language === 'BM' ? 'Sumber Video Pengimbas' : 'Scanner Video Source'}
            </span>
            <span className="text-[10px] px-2 py-0.5 rounded-full bg-cyan-950/80 text-cyan-400 font-bold border border-cyan-800/60">
              {scannerSourceMode === 'SAMPLE_VIDEO'
                ? language === 'BM' ? 'Mod Video Latihan' : 'Training Video Feed'
                : language === 'BM' ? 'Kamera Fizikal' : 'Live Webcam'}
            </span>
          </div>

          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => {
                if (scannerSourceMode !== 'SAMPLE_VIDEO') {
                  stopCamera();
                  setScannerSourceMode('SAMPLE_VIDEO');
                  scannerSourceModeRef.current = 'SAMPLE_VIDEO';
                }
              }}
              className={\`px-3 py-1.5 rounded-lg text-[11px] font-bold transition-all flex items-center gap-1.5 \${
                scannerSourceMode === 'SAMPLE_VIDEO'
                  ? 'bg-cyan-600 text-white shadow-md'
                  : 'bg-slate-950/50 text-slate-400 border border-slate-800 hover:text-slate-200'
              }\`}
            >
              <Clapperboard className="w-3.5 h-3.5" />
              <span>
                {language === 'BM'
                  ? \`Video Latihan (\${TRAINING_VIDEOS.length} Sampel)\`
                  : \`Training Videos (\${TRAINING_VIDEOS.length} Clips)\`}
              </span>
            </button>
            <button
              type="button"
              onClick={() => {
                if (scannerSourceMode !== 'CAMERA') {
                  stopCamera();
                  setScannerSourceMode('CAMERA');
                  scannerSourceModeRef.current = 'CAMERA';
                }
              }}
              className={\`px-3 py-1.5 rounded-lg text-[11px] font-bold transition-all flex items-center gap-1.5 \${
                scannerSourceMode === 'CAMERA'
                  ? 'bg-cyan-600 text-white shadow-md'
                  : 'bg-slate-950/50 text-slate-400 border border-slate-800 hover:text-slate-200'
              }\`}
            >
              <Camera className="w-3.5 h-3.5" />
              <span>{language === 'BM' ? 'Webcam Langsung' : 'Live Webcam'}</span>
            </button>
          </div>
        </div>

        {scannerSourceMode === 'SAMPLE_VIDEO' && (
          <div className="space-y-3">
            <div className="flex flex-col sm:flex-row gap-3">
              <div className="flex-1">
                <label className="text-[9px] font-bold text-slate-500 uppercase tracking-wider block mb-1.5">
                  {language === 'BM' ? 'Pilih Klip Kereta Sebenar' : 'Select Real Vehicle Clip'}
                </label>
                <select
                  value={customUploadedVideoUrl ? 'custom' : selectedTrainingVideoId}
                  onChange={(e) => {
                    if (e.target.value !== 'custom') {
                      void handleSelectTrainingVideo(e.target.value);
                    }
                  }}
                  className="w-full rounded-xl bg-slate-950 border border-slate-700/80 px-3 py-2 text-xs font-semibold text-slate-200 focus:outline-none focus:border-cyan-500"
                >
                  {TRAINING_VIDEOS.map((video) => (
                    <option key={video.id} value={video.id}>
                      {video.title} — 🎯 {video.expectedPlates.join(', ')}
                    </option>
                  ))}
                  {customUploadedVideoUrl && (
                    <option value="custom">📁 Custom Uploaded Video File</option>
                  )}
                </select>
              </div>

              <div className="sm:w-48 flex items-end">
                <label className="w-full cursor-pointer rounded-xl border border-slate-700 bg-slate-900/50 hover:bg-slate-800 px-3 py-2 text-[11px] font-bold text-slate-300 transition-all flex items-center justify-center gap-2 hover:border-cyan-600 hover:text-cyan-200">
                  <Upload className="w-3.5 h-3.5 text-cyan-400" />
                  <span>{language === 'BM' ? 'Muat Naik Video...' : 'Upload Video...'}</span>
                  <input
                    type="file"
                    accept="video/mp4,video/webm,video/quicktime,video/mov"
                    onChange={(e) => void handleCustomVideoUpload(e)}
                    className="hidden"
                  />
                </label>
              </div>
            </div>

            {(() => {
              const activeMeta = getTrainingVideoById(selectedTrainingVideoId);
              if (!activeMeta && !customUploadedVideoUrl) return null;
              return (
                <div className="rounded-xl bg-cyan-950/20 border border-cyan-900/40 px-3 py-2 text-[10px] flex flex-wrap gap-2 items-center text-slate-400">
                  <span className="font-bold text-cyan-400">
                    {customUploadedVideoUrl ? 'Custom Video' : activeMeta?.title}:
                  </span>
                  <span>
                    {customUploadedVideoUrl ? 'Local video file running in live simulation' : activeMeta?.description}
                  </span>
                  {!customUploadedVideoUrl && activeMeta?.expectedPlates && (
                    <div className="flex items-center gap-1.5 ml-auto">
                      <span className="font-bold uppercase text-[9px]">Targets:</span>
                      {activeMeta.expectedPlates.map((plate) => (
                        <span key={plate} className="px-1.5 py-0.5 rounded bg-cyan-900/50 text-cyan-200 font-mono font-bold border border-cyan-700/50">
                          {plate}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              );
            })()}
          </div>
        )}
      </div>

      `;

content = content.replace(videoSourceBlockOld, videoSourceBlockNew);

// 3. Add Start Scanning button next to Pratonton in Camera Overlay
const oldControls = `<button
                    type="button"
                    onClick={(event) => {
                      event.stopPropagation();
                      void handleUseCamera(slot, index);
                    }}
                    className="h-7 rounded-lg border border-cyan-700 bg-cyan-950/90 px-2 text-[10px] font-bold text-cyan-200 hover:bg-cyan-900"
                  >
                    {language === 'BM' ? 'Pratonton' : 'Preview'}
                  </button>`;

const newControls = `<button
                    type="button"
                    onClick={(event) => {
                      event.stopPropagation();
                      void handleUseCamera(slot, index);
                    }}
                    className="h-7 rounded-lg border border-cyan-800 bg-cyan-950/90 px-2.5 text-[10px] font-bold text-cyan-200 hover:bg-cyan-900"
                  >
                    {language === 'BM' ? 'Pratonton' : 'Preview'}
                  </button>
                  {isScanning ? (
                    <button
                      onClick={(event) => {
                        event.stopPropagation();
                        handleStopScanning();
                      }}
                      className="h-7 rounded-lg border border-red-700 bg-red-950/90 px-2.5 text-[10px] font-bold text-red-200 hover:bg-red-900 flex items-center gap-1.5"
                    >
                      <span className="h-1.5 w-1.5 rounded-sm bg-red-500 shadow-[0_0_6px_rgba(239,68,68,0.8)]" />
                      {language === 'BM' ? 'Henti' : 'Stop'}
                    </button>
                  ) : (
                    <button
                      onClick={(event) => {
                        event.stopPropagation();
                        void handleStartScanning();
                      }}
                      className="h-7 rounded-lg border border-emerald-600 bg-emerald-700/90 px-2.5 text-[10px] font-black uppercase text-white shadow-lg shadow-emerald-900/50 hover:bg-emerald-600 flex items-center gap-1"
                    >
                      <Play className="w-3 h-3" />
                      {language === 'BM' ? 'Mula' : 'Start'}
                    </button>
                  )}`;

content = content.replace(oldControls, newControls);

fs.writeFileSync('src/app/scanner/page.tsx', content);
