/** Wait for actual decoded pixels, not merely an assigned source URL. */
export function waitForDecodedFrame(video: HTMLVideoElement, timeoutMs = 15000): Promise<void> {
  if (video.readyState >= 2 && video.videoWidth > 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      video.removeEventListener('loadeddata', ready);
      video.removeEventListener('canplay', ready);
      video.removeEventListener('error', failed);
    };
    const ready = () => {
      if (video.readyState < 2 || video.videoWidth === 0) return;
      cleanup(); resolve();
    };
    const failed = () => { cleanup(); reject(new Error('Unable to decode the video source.')); };
    const timer = setTimeout(() => { cleanup(); reject(new Error('Timed out preparing the video source.')); }, timeoutMs);
    video.addEventListener('loadeddata', ready);
    video.addEventListener('canplay', ready);
    video.addEventListener('error', failed);
    ready();
  });
}
