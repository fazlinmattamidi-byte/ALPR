export interface TrainingVideoMeta {
  id: string;
  title: string;
  filename: string;
  url: string;
  durationSeconds: number;
  resolution: { width: number; height: number };
  expectedPlates: string[];
  description: string;
  category:
    | 'SINGLE_APPROACH'
    | 'MULTI_VEHICLE'
    | 'FAST_PASSING'
    | 'STEADY_APPROACH'
    | 'DEPARTING_QUEUE'
    | 'STATIC_MULTI_PLATE'
    | 'CAMERA_PAN';
}

export const TRAINING_VIDEOS: TrainingVideoMeta[] = [
  {
    id: 'clip-1',
    title: 'Sample 1 — Slow Approach (BNC 115)',
    filename: 'WhatsApp Video 2026-09-15 at 15.10.37.mp4',
    url: '/train-video/WhatsApp Video 2026-09-15 at 15.10.37.mp4',
    durationSeconds: 6.6,
    resolution: { width: 1024, height: 576 },
    expectedPlates: ['BNC 115'],
    description: 'Vehicle slowly entering camera view from distance and decelerating.',
    category: 'SINGLE_APPROACH',
  },
  {
    id: 'clip-2',
    title: 'Sample 2 — Multi-Vehicle Succession (VNN 1212 → SWF 3587)',
    filename: 'WhatsApp Video 2026-09-15 at 15.10.38.mp4',
    url: '/train-video/WhatsApp Video 2026-09-15 at 15.10.38.mp4',
    durationSeconds: 2.3,
    resolution: { width: 1024, height: 576 },
    expectedPlates: ['VNN 1212', 'SWF 3587'],
    description: 'First car passes out of view, followed immediately by second approaching car.',
    category: 'MULTI_VEHICLE',
  },
  {
    id: 'clip-3',
    title: 'Sample 3 — Steady Drive-by (ANN 7569)',
    filename: 'WhatsApp Video 2026-09-15 at 15.10.40.mp4',
    url: '/train-video/WhatsApp Video 2026-09-15 at 15.10.40.mp4',
    durationSeconds: 3.5,
    resolution: { width: 1024, height: 576 },
    expectedPlates: ['ANN 7569'],
    description: 'Vehicle approaching steadily with clear front plate recognition.',
    category: 'STEADY_APPROACH',
  },
  {
    id: 'clip-4',
    title: 'Sample 4 — Convoy & Queue (VPM 9310 → WUY 6243)',
    filename: 'WhatsApp Video 2026-09-15 at 15.10.43.mp4',
    url: '/train-video/WhatsApp Video 2026-09-15 at 15.10.43.mp4',
    durationSeconds: 4.2,
    resolution: { width: 1024, height: 576 },
    expectedPlates: ['VPM 9310', 'WUY 6243'],
    description: 'Vehicles moving in convoy sequence past the camera checkpoint.',
    category: 'MULTI_VEHICLE',
  },
  {
    id: 'clip-5',
    title: 'Sample 5 — Cornering & Angled Approach (WTH 931 → VPX 8709)',
    filename: 'WhatsApp Video 2026-09-15 at 15.10.45.mp4',
    url: '/train-video/WhatsApp Video 2026-09-15 at 15.10.45.mp4',
    durationSeconds: 4.2,
    resolution: { width: 1024, height: 576 },
    expectedPlates: ['WTH 931', 'VPX 8709'],
    description: 'Vehicles turning slightly diagonally across field of view.',
    category: 'FAST_PASSING',
  },
  {
    id: 'clip-6',
    title: 'Sample 6 — Distance Transition (ALC 9189 → VFT 836)',
    filename: 'WhatsApp Video 2026-09-15 at 15.10.48.mp4',
    url: '/train-video/WhatsApp Video 2026-09-15 at 15.10.48.mp4',
    durationSeconds: 6.8,
    resolution: { width: 1024, height: 576 },
    expectedPlates: ['ALC 9189', 'VFT 836'],
    description: 'First car moves away into distance, followed by cross-traffic vehicle.',
    category: 'DEPARTING_QUEUE',
  },
  {
    id: 'clip-7',
    title: 'Sample 7 — Parking Entry Pair (SJC 6080 → NEA 7567)',
    filename: 'WhatsApp Video 2026-09-15 at 15.10.51.mp4',
    url: '/train-video/WhatsApp Video 2026-09-15 at 15.10.51.mp4',
    durationSeconds: 5.5,
    resolution: { width: 1024, height: 576 },
    expectedPlates: ['SJC 6080', 'NEA 7567'],
    description: 'Vehicles entering parking lane with changing perspectives.',
    category: 'MULTI_VEHICLE',
  },
  {
    id: 'clip-8',
    title: 'Sample 8 — Urban Cross-Traffic (WC 5855 E)',
    filename: 'WhatsApp Video 2026-09-18 at 11.05.48.mp4',
    url: '/train-video/WhatsApp Video 2026-09-18 at 11.05.48.mp4',
    durationSeconds: 7.8,
    resolution: { width: 720, height: 1280 },
    expectedPlates: ['WC 5855 E'],
    description: 'Busy urban junction with motorcycles, a van, and several cars crossing at different depths.',
    category: 'MULTI_VEHICLE',
  },
  {
    id: 'clip-9',
    title: 'Sample 9 — Fast Angled Pass (AMA 4588)',
    filename: 'WhatsApp Video 2026-09-18 at 11.05.50.mp4',
    url: '/train-video/WhatsApp Video 2026-09-18 at 11.05.50.mp4',
    durationSeconds: 4,
    resolution: { width: 720, height: 1280 },
    expectedPlates: ['AMA 4588'],
    description: 'A vehicle approaches diagonally at 60 FPS and quickly exits the camera view.',
    category: 'FAST_PASSING',
  },
  {
    id: 'clip-10',
    title: 'Sample 10 — Parked Vehicle Sweep (SYQ 9096 → WYS 4460 → BQF 902 → VDG 5534)',
    filename: 'WhatsApp Video 2026-09-18 at 11.05.54.mp4',
    url: '/train-video/WhatsApp Video 2026-09-18 at 11.05.54.mp4',
    durationSeconds: 7.3,
    resolution: { width: 1280, height: 720 },
    expectedPlates: ['SYQ 9096', 'WYS 4460', 'BQF 902', 'VDG 5534'],
    description: 'Camera sweep across a row of stationary vehicles with multiple clear front plates.',
    category: 'STATIC_MULTI_PLATE',
  },
  {
    id: 'clip-11',
    title: 'Sample 11 — Parking-Lot Rear Plate Pan (VME 7108)',
    filename: 'WhatsApp Video 2026-09-18 at 11.05.56.mp4',
    url: '/train-video/WhatsApp Video 2026-09-18 at 11.05.56.mp4',
    durationSeconds: 5,
    resolution: { width: 1280, height: 720 },
    expectedPlates: ['MCT 8619', 'CFJ 6611', 'VEQ 8471', 'VNF 3296', 'CCC 769', 'VGA 1268', 'VME 7108'],
    description: 'Handheld pan through a busy parking area ending on a close rear plate.',
    category: 'CAMERA_PAN',
  },
  {
    id: 'clip-12',
    title: 'Sample 12 — Roadside Front Plate Pan (WAM 1284)',
    filename: 'WhatsApp Video 2026-09-18 at 11.05.59.mp4',
    url: '/train-video/WhatsApp Video 2026-09-18 at 11.05.59.mp4',
    durationSeconds: 4.2,
    resolution: { width: 1280, height: 720 },
    expectedPlates: ['WAM 1284'],
    description: 'Handheld roadside sweep settling on a close, angled front plate.',
    category: 'CAMERA_PAN',
  },
  {
    id: 'clip-13',
    title: 'Sample 13 — Night Parking Sweep',
    filename: 'WhatsApp Video 2026-09-26 at 03.22.37.mp4',
    url: '/train-video/WhatsApp Video 2026-09-26 at 03.22.37.mp4',
    durationSeconds: 9.2,
    resolution: { width: 464, height: 832 },
    expectedPlates: [],
    description: 'Portrait night sweep across parked vehicles with glare and partial views.',
    category: 'CAMERA_PAN',
  },
  {
    id: 'clip-14',
    title: 'Sample 14 — Night Street Parking Pan',
    filename: 'WhatsApp Video 2026-09-26 at 03.22.40.mp4',
    url: '/train-video/WhatsApp Video 2026-09-26 at 03.22.40.mp4',
    durationSeconds: 10,
    resolution: { width: 720, height: 1280 },
    expectedPlates: [],
    description: 'Portrait night street scene with moving camera and multiple parked vehicles.',
    category: 'CAMERA_PAN',
  },
  {
    id: 'clip-15',
    title: 'Sample 15 — Parked Front Plate (JPW 7488)',
    filename: 'WhatsApp Video 2026-09-26 at 03.22.43.mp4',
    url: '/train-video/WhatsApp Video 2026-09-26 at 03.22.43.mp4',
    durationSeconds: 3.2,
    resolution: { width: 1280, height: 720 },
    expectedPlates: ['JPW 7488'],
    description: 'Night parking-lot pass settling on a clear front plate.',
    category: 'STATIC_MULTI_PLATE',
  },
  {
    id: 'clip-16',
    title: 'Sample 16 — Night Parking Row',
    filename: 'WhatsApp Video 2026-09-26 at 03.22.45.mp4',
    url: '/train-video/WhatsApp Video 2026-09-26 at 03.22.45.mp4',
    durationSeconds: 1.7,
    resolution: { width: 1280, height: 720 },
    expectedPlates: [],
    description: 'Short night sweep across a row of parked vehicles.',
    category: 'STATIC_MULTI_PLATE',
  },
  {
    id: 'clip-17',
    title: 'Sample 17 — Night Parking-Lot Sweep',
    filename: 'WhatsApp Video 2026-09-26 at 03.22.47.mp4',
    url: '/train-video/WhatsApp Video 2026-09-26 at 03.22.47.mp4',
    durationSeconds: 3.1,
    resolution: { width: 1280, height: 720 },
    expectedPlates: [],
    description: 'Night camera sweep across parked vehicles at different distances.',
    category: 'STATIC_MULTI_PLATE',
  },
  {
    id: 'clip-18',
    title: 'Sample 18 — Portrait Night Parking Pan',
    filename: 'WhatsApp Video 2026-09-26 at 03.22.50.mp4',
    url: '/train-video/WhatsApp Video 2026-09-26 at 03.22.50.mp4',
    durationSeconds: 10.6,
    resolution: { width: 464, height: 832 },
    expectedPlates: [],
    description: 'Portrait night pan through a busy parking area.',
    category: 'CAMERA_PAN',
  },
  {
    id: 'clip-19',
    title: 'Sample 19 — Night Traffic Rear Plate (VEM 9932)',
    filename: 'WhatsApp Video 2026-09-26 at 03.23.07.mp4',
    url: '/train-video/WhatsApp Video 2026-09-26 at 03.23.07.mp4',
    durationSeconds: 2.1,
    resolution: { width: 1280, height: 720 },
    expectedPlates: ['VEM 9932'],
    description: 'Night traffic clip ending on a close rear plate.',
    category: 'STEADY_APPROACH',
  },
  {
    id: 'clip-20',
    title: 'Sample 20 — Night Traffic Rear Plate (JRX 9956)',
    filename: 'WhatsApp Video 2026-09-26 at 03.23.11.mp4',
    url: '/train-video/WhatsApp Video 2026-09-26 at 03.23.11.mp4',
    durationSeconds: 5.8,
    resolution: { width: 1280, height: 720 },
    expectedPlates: ['JRX 9956'],
    description: 'Night traffic queue with glare and a close rear plate.',
    category: 'STEADY_APPROACH',
  },
];

export function getTrainingVideos(): TrainingVideoMeta[] {
  return TRAINING_VIDEOS;
}

export function getTrainingVideoById(id: string): TrainingVideoMeta | undefined {
  return TRAINING_VIDEOS.find((v) => v.id === id);
}
