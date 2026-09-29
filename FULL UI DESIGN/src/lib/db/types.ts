export type CaseStatus = 'ACTIVE' | 'ON_HOLD' | 'RECOVERED' | 'CLOSED';
export type MatchType = 'EXACT' | 'POSSIBLE' | 'NONE' | 'INSUFFICIENT_CONFIDENCE';
export type SearchSource = 'MANUAL' | 'CAMERA';

export type PlateCategory =
  | 'STANDARD'
  | 'LETTER_NUMBER_SUFFIX'
  | 'SABAH'
  | 'SARAWAK'
  | 'LANGKAWI'
  | 'PUTRAJAYA'
  | 'EV_SPECIAL'
  | 'SPECIAL_SERIES'
  | 'DIPLOMATIC'
  | 'MOTORCYCLE'
  | 'GOVERNMENT'
  | 'INSTITUTIONAL'
  | 'UNKNOWN_VALID_CANDIDATE';

export type PlateLayout = 'SINGLE_LINE' | 'TWO_LINE' | 'SQUARE';

// Per-track OCR state machine
export type TrackOcrState =
  | 'DETECTED'
  | 'COLLECTING'
  | 'QUALITY READY'
  | 'OCR RUNNING'
  | 'CONSENSUS'
  | 'DATABASE CHECK'
  | 'MATCHED'
  | 'NO CASE'
  | 'POSSIBLE MATCH'
  | 'LOW QUALITY'
  | 'COOLDOWN'
  | 'CROP_READY'
  | 'OCR_RUNNING'
  | 'CONSENSUS_BUILDING'
  | 'VALIDATING'
  | 'DB_CHECKING'
  | 'LOW_CONFIDENCE'
  | 'NOT_FOUND';

export interface VehicleCase {
  id: string;
  plateNumber: string;
  normalizedPlate: string;
  customerName: string;
  customerReference?: string;
  vehicleMake: string;
  vehicleModel: string;
  vehicleColor: string;
  vehicleYear?: number;
  vehicleType?: string;
  chassisNumber?: string;
  financeCompany: string;
  outstandingAmount: number;
  caseReference: string;
  status: CaseStatus;
  notes?: string;
  createdAt: string;
  updatedAt: string;
  lastDetectedAt?: string;
  detectionCount?: number;

  // Universal ANPR Metadata Extensions
  plateCategory?: PlateCategory;
  plateLayout?: PlateLayout;
  expectedBackground?: 'BLACK' | 'WHITE' | 'RED' | 'GREEN' | 'CUSTOM';
  expectedCharacterColour?: 'WHITE' | 'BLACK' | 'RED' | 'SILVER';
  optionalPrefix?: string;
  optionalSuffix?: string;
  stateOrTerritory?: string;
  vehicleFuelType?: 'PETROL' | 'DIESEL' | 'HYBRID' | 'ELECTRIC';
  isElectricVehicle?: boolean;
}

export interface CharacterConfidence {
  char: string;
  confidence: number; // 0.0 - 1.0
  position: number;
  alternatives?: { char: string; confidence: number }[];
}

export interface ScanEvent {
  id: string;
  detectedPlate: string;
  displayPlate?: string;
  normalizedPlate: string;
  confidence: number;
  matchType: MatchType;
  matchedVehicleId?: string;
  source: SearchSource;
  trackId?: string;
  deviceInfo?: string;
  confirmed?: boolean;
  reportedWrong?: boolean;
  cropDataUrl?: string;
  frameCount?: number;
  firstSeenAt?: string;
  confirmedAt?: string;
  detectedAt: string;

  // Extended ANPR Scan Diagnostics
  detectedCategory?: PlateCategory;
  detectedLayout?: PlateLayout;
  characterConfidences?: CharacterConfidence[];
  qualityScore?: number;
}

export interface SearchEvent {
  id: string;
  searchValue: string;
  normalizedPlate: string;
  matchType: MatchType;
  matchedVehicleId?: string;
  source: SearchSource;
  confidence?: number;
  searchedAt: string;
}

export interface AuditLog {
  id: string;
  action: 'CREATE' | 'UPDATE' | 'DELETE' | 'IMPORT' | 'CONFIRM_SCAN' | 'REPORT_WRONG';
  entityType: 'VEHICLE' | 'SCAN';
  entityId: string;
  previousValue?: any;
  newValue?: any;
  createdAt: string;
}

export interface ScannerSettings {
  preferredCamera: string;
  preferredResolution: '720p' | '1080p' | '480p';
  soundEnabled: boolean;
  vibrationEnabled: boolean;
  detectorEngine: 'AUTO' | 'LOCAL_ONNX' | 'CV_HEURISTIC';
  ocrEngine: 'TESSERACT' | 'ONNX_MODEL';
  detectionThreshold: number;       // 0.0 - 1.0
  recognitionThreshold: number;     // 0.0 - 1.0
  characterConfidenceThreshold: number; // 0.0 - 1.0
  consensusVotes: number;           // 2 - 5
  duplicateCooldown: number;        // seconds
  maxTracks: number;                // e.g. 8
  maxOcrConcurrency: number;        // e.g. 3
  candidatePermutationLimit: number; // e.g. 10 max confusion alternatives
  minCropWidth: number;             // e.g. 50 px
  minCropQuality: number;           // e.g. 0.20
  lostTrackTimeout: number;         // frames before removing lost track
  scannerMode: 'MULTI_VEHICLE' | 'SINGLE_TARGET';
  showCenterGuide: boolean;         // false by default
  pauseAfterMatch: boolean;         // false by default for multi-vehicle
  enableSpecialSeries: boolean;
  enableDiplomatic: boolean;
  showPlateCategory: boolean;
  showRawOcr: boolean;
  showCharConfidence: boolean;
  debugMode: boolean;
  demoAssistance: boolean;
}

export interface DashboardStats {
  totalVehicles: number;
  activeCases: number;
  matchesFound: number;
  manualSearches: number;
  cameraScans: number;
  possibleMatches: number;
  scansToday: number;
}
