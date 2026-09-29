import type { AdaptiveScannerConfig } from './adaptiveConfig';
import type { FrameImageStats } from './environmentIntelligence';

export type CameraKind = 'USB_WEBCAM' | 'BUILT_IN_CAMERA' | 'UNKNOWN_CAMERA';
export type CameraHealthStatus = 'OK' | 'WARN' | 'FAIL' | 'UNKNOWN';

export interface DesktopCameraDevice {
  deviceId: string;
  groupId: string;
  label: string;
  kind: CameraKind;
}

export interface CameraRuntimeMetadata {
  deviceId: string;
  label: string;
  kind: CameraKind;
  width: number;
  height: number;
  fps: number;
  aspectRatio: number;
}

export interface CameraHealthSnapshot {
  status: CameraHealthStatus;
  score: number;
  brightness: number;
  contrast: number;
  blurScore: number;
  droppedFrames: number;
  fps: number;
  detail: string;
}

const SELECTED_CAMERA_STORAGE_KEY = 'plateq.desktop.selectedCameraId';

export const DESKTOP_CAMERA_PROFILE = {
  preferredWidth: 1920,
  preferredHeight: 1080,
  preferredFps: 30,
  fallbackWidth: 1280,
  fallbackHeight: 720,
} as const;

export function rememberSelectedCamera(deviceId: string): void {
  if (typeof localStorage === 'undefined' || !deviceId) return;
  localStorage.setItem(SELECTED_CAMERA_STORAGE_KEY, deviceId);
}

export function getRememberedCameraId(): string {
  if (typeof localStorage === 'undefined') return '';
  return localStorage.getItem(SELECTED_CAMERA_STORAGE_KEY) || '';
}

export async function enumerateDesktopCameras(): Promise<DesktopCameraDevice[]> {
  if (!navigator.mediaDevices?.enumerateDevices) return [];

  // Browsers only reveal full device labels and all connected cameras AFTER
  // camera permission has been granted. We do a silent permission probe first,
  // then re-enumerate so that secondary cameras (e.g. USB/OBSBOT webcams)
  // appear with correct labels and unique deviceIds.
  const existingDevices = await navigator.mediaDevices.enumerateDevices();
  const hasPermission = existingDevices
    .filter((d) => d.kind === 'videoinput')
    .some((d) => d.label !== '');

  if (!hasPermission) {
    try {
      const probe = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
      probe.getTracks().forEach((t) => t.stop());
    } catch {
      // Permission denied – fall through and return whatever devices we can.
    }
  }

  const devices = await navigator.mediaDevices.enumerateDevices();
  return devices
    .filter((device) => device.kind === 'videoinput')
    .map((device, index) => ({
      deviceId: device.deviceId,
      groupId: device.groupId,
      label: device.label || `Camera ${index + 1}`,
      kind: classifyCameraKind(device.label || '', index),
    }));
}

export function selectPreferredCamera(
  devices: DesktopCameraDevice[],
  requestedDeviceId = getRememberedCameraId()
): DesktopCameraDevice | null {
  if (devices.length === 0) return null;

  if (requestedDeviceId) {
    const requested = devices.find((device) => device.deviceId === requestedDeviceId);
    if (requested) return requested;
  }

  return (
    devices.find((device) => device.kind === 'USB_WEBCAM') ||
    devices.find((device) => device.kind === 'BUILT_IN_CAMERA') ||
    devices[0]
  );
}

export function buildDesktopCameraConstraints(
  deviceId = '',
  cameraConfig?: AdaptiveScannerConfig['camera'],
  fallback = false,
  facingMode?: 'user' | 'environment'
): MediaTrackConstraints {
  const idealWidth = fallback
    ? cameraConfig?.fallbackWidth ?? DESKTOP_CAMERA_PROFILE.fallbackWidth
    : cameraConfig?.idealWidth ?? DESKTOP_CAMERA_PROFILE.preferredWidth;
  const idealHeight = fallback
    ? cameraConfig?.fallbackHeight ?? DESKTOP_CAMERA_PROFILE.fallbackHeight
    : cameraConfig?.idealHeight ?? DESKTOP_CAMERA_PROFILE.preferredHeight;
  const idealFps = cameraConfig?.idealFps ?? DESKTOP_CAMERA_PROFILE.preferredFps;
  const constraints: MediaTrackConstraints = {
    width: { ideal: idealWidth },
    height: { ideal: idealHeight },
    frameRate: { ideal: idealFps, max: Math.max(idealFps, 30) },
  };

  if (deviceId) {
    constraints.deviceId = { exact: deviceId };
  } else if (facingMode) {
    constraints.facingMode = { ideal: facingMode };
  }

  return constraints;
}

export async function openDesktopCameraStream(
  deviceId = '',
  cameraConfig?: AdaptiveScannerConfig['camera'],
  facingMode?: 'user' | 'environment'
): Promise<MediaStream> {
  try {
    return await navigator.mediaDevices.getUserMedia({
      video: buildDesktopCameraConstraints(deviceId, cameraConfig, false, facingMode),
      audio: false,
    });
  } catch (primaryError) {
    try {
      return await navigator.mediaDevices.getUserMedia({
        video: buildDesktopCameraConstraints(deviceId, cameraConfig, true, facingMode),
        audio: false,
      });
    } catch {
      throw primaryError;
    }
  }
}

export function getCameraRuntimeMetadata(
  stream: MediaStream,
  device?: DesktopCameraDevice | null
): CameraRuntimeMetadata {
  const track = stream.getVideoTracks()[0];
  const settings = track?.getSettings?.() || {};
  const width = settings.width ?? 0;
  const height = settings.height ?? 0;
  const fps = settings.frameRate ?? 0;

  return {
    deviceId: settings.deviceId || device?.deviceId || '',
    label: track?.label || device?.label || 'Desktop Camera',
    kind: device?.kind ?? classifyCameraKind(track?.label || device?.label || '', 0),
    width,
    height,
    fps,
    aspectRatio: height > 0 ? Math.round((width / height) * 100) / 100 : 0,
  };
}

export function createCameraHealthSnapshot(
  frameStats: FrameImageStats | undefined,
  fps: number,
  droppedFrames: number
): CameraHealthSnapshot {
  if (!frameStats) {
    return {
      status: 'UNKNOWN',
      score: 0,
      brightness: 0,
      contrast: 0,
      blurScore: 0,
      droppedFrames,
      fps,
      detail: 'waiting for frame sample',
    };
  }

  const fpsScore = Math.min(100, Math.round((fps / 24) * 100));
  const brightnessPenalty =
    frameStats.brightness < 0.18 || frameStats.brightness > 0.86
      ? 22
      : frameStats.brightness < 0.28 || frameStats.brightness > 0.78
      ? 10
      : 0;
  const contrastPenalty = frameStats.contrast < 0.16 ? 22 : frameStats.contrast < 0.24 ? 10 : 0;
  const blurPenalty = frameStats.blurScore < 0.18 ? 22 : frameStats.blurScore < 0.30 ? 10 : 0;
  const droppedPenalty = Math.min(28, droppedFrames * 3);
  const score = Math.max(0, Math.min(100, fpsScore - brightnessPenalty - contrastPenalty - blurPenalty - droppedPenalty));
  const status: CameraHealthStatus = score >= 82 ? 'OK' : score >= 55 ? 'WARN' : 'FAIL';
  const detail = `${fps.toFixed(0)} FPS · light ${Math.round(frameStats.brightness * 100)}% · contrast ${Math.round(
    frameStats.contrast * 100
  )}%`;

  return {
    status,
    score,
    brightness: frameStats.brightness,
    contrast: frameStats.contrast,
    blurScore: frameStats.blurScore,
    droppedFrames,
    fps,
    detail,
  };
}

export function streamNeedsReconnect(stream?: MediaStream): boolean {
  if (!stream) return true;
  const tracks = stream.getVideoTracks();
  return tracks.length === 0 || tracks.every((track) => track.readyState === 'ended');
}

function classifyCameraKind(label: string, index: number): CameraKind {
  const normalized = label.toLowerCase();
  if (/usb|webcam|external|logitech|brio|c922|c920|elgato|aver|obsbot|razer|anker/.test(normalized)) {
    return 'USB_WEBCAM';
  }
  if (/facetime|built.?in|integrated|internal|hd camera|isight/.test(normalized) || index === 0) {
    return 'BUILT_IN_CAMERA';
  }
  return 'UNKNOWN_CAMERA';
}
