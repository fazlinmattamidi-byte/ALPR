import fs from 'fs';
import path from 'path';
import {
  VehicleCase,
  ScanEvent,
  SearchEvent,
  AuditLog,
  ScannerSettings,
  DashboardStats,
  CaseStatus,
  MatchType,
  SearchSource,
  CharacterConfidence,
  PlateCategory,
} from './types';
import { INITIAL_VEHICLES, INITIAL_SETTINGS } from './seedData';
import { normalizePlate } from '../anpr/normaliser';
import { evaluateDatabaseMatch } from '../anpr/matchingEngine';

interface StorageSchema {
  vehicles: VehicleCase[];
  scanEvents: ScanEvent[];
  searchEvents: SearchEvent[];
  auditLogs: AuditLog[];
  settings: ScannerSettings;
}

// Memory store fallback (for Vercel & client/serverless environments)
let inMemoryStore: StorageSchema = {
  vehicles: [...INITIAL_VEHICLES],
  scanEvents: [],
  searchEvents: [],
  auditLogs: [],
  settings: { ...INITIAL_SETTINGS },
};

const DATA_DIR = path.join(process.cwd(), '.data');
const DATA_FILE = path.join(DATA_DIR, 'plateq.json');

function isNodeFsAvailable(): boolean {
  return typeof window === 'undefined';
}

function loadStore(): StorageSchema {
  if (!isNodeFsAvailable()) {
    return inMemoryStore;
  }

  try {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }

    if (!fs.existsSync(DATA_FILE)) {
      const initialData: StorageSchema = {
        vehicles: INITIAL_VEHICLES,
        scanEvents: [],
        searchEvents: [],
        auditLogs: [],
        settings: INITIAL_SETTINGS,
      };
      fs.writeFileSync(DATA_FILE, JSON.stringify(initialData, null, 2), 'utf-8');
      inMemoryStore = initialData;
      return initialData;
    }

    const fileContent = fs.readFileSync(DATA_FILE, 'utf-8');
    const parsed = JSON.parse(fileContent);
    inMemoryStore = parsed;
    return parsed;
  } catch (err) {
    console.warn('Fs load failed, using in-memory store fallback:', err);
    return inMemoryStore;
  }
}

function saveStore(store: StorageSchema): void {
  inMemoryStore = store;
  if (!isNodeFsAvailable()) return;

  try {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    fs.writeFileSync(DATA_FILE, JSON.stringify(store, null, 2), 'utf-8');
  } catch (err) {
    console.warn('Fs save failed (Vercel serverless environment):', err);
  }
}

export class PlateQRepository {
  static getDashboardStats(): DashboardStats {
    const store = loadStore();
    const todayStr = new Date().toISOString().substring(0, 10);

    const totalVehicles = store.vehicles.length;
    const activeCases = store.vehicles.filter((v) => v.status === 'ACTIVE').length;

    // Matches found across scans & manual searches
    const matchScans = store.scanEvents.filter((s) => s.matchType === 'EXACT').length;
    const matchSearches = store.searchEvents.filter((s) => s.matchType === 'EXACT').length;
    const matchesFound = matchScans + matchSearches;

    const manualSearches = store.searchEvents.length;
    const cameraScans = store.scanEvents.length;
    const possibleMatches = store.scanEvents.filter((s) => s.matchType === 'POSSIBLE').length +
                            store.searchEvents.filter((s) => s.matchType === 'POSSIBLE').length;

    const scansToday = store.scanEvents.filter((s) => s.detectedAt.startsWith(todayStr)).length;

    return {
      totalVehicles,
      activeCases,
      matchesFound,
      manualSearches,
      cameraScans,
      possibleMatches,
      scansToday,
    };
  }

  static listVehicles(params?: {
    query?: string;
    status?: CaseStatus | 'ALL';
    financeCompany?: string;
    vehicleMake?: string;
  }): VehicleCase[] {
    const store = loadStore();
    let result = [...store.vehicles];

    if (params?.status && params.status !== 'ALL') {
      result = result.filter((v) => v.status === params.status);
    }

    if (params?.financeCompany && params.financeCompany !== 'ALL') {
      result = result.filter((v) => v.financeCompany === params.financeCompany);
    }

    if (params?.vehicleMake && params.vehicleMake !== 'ALL') {
      result = result.filter((v) => v.vehicleMake === params.vehicleMake);
    }

    if (params?.query) {
      const q = params.query.toLowerCase().trim();
      const normQ = normalizePlate(q);
      result = result.filter(
        (v) =>
          v.plateNumber.toLowerCase().includes(q) ||
          v.normalizedPlate.includes(normQ) ||
          v.customerName.toLowerCase().includes(q) ||
          v.vehicleMake.toLowerCase().includes(q) ||
          v.vehicleModel.toLowerCase().includes(q) ||
          v.financeCompany.toLowerCase().includes(q) ||
          v.caseReference.toLowerCase().includes(q)
      );
    }

    return result.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  }

  static getVehicleById(id: string): VehicleCase | null {
    const store = loadStore();
    return store.vehicles.find((v) => v.id === id) || null;
  }

  static getVehicleByNormalizedPlate(normPlate: string): VehicleCase | null {
    const store = loadStore();
    return store.vehicles.find((v) => v.normalizedPlate === normPlate) || null;
  }

  static createVehicle(data: Omit<VehicleCase, 'id' | 'normalizedPlate' | 'createdAt' | 'updatedAt'>): {
    success: boolean;
    vehicle?: VehicleCase;
    error?: string;
  } {
    const store = loadStore();
    const normalized = normalizePlate(data.plateNumber);

    if (!normalized) {
      return { success: false, error: 'Nombor plat tidak sah' };
    }

    const existing = store.vehicles.find((v) => v.normalizedPlate === normalized);
    if (existing) {
      return { success: false, error: `Nombor plat ${data.plateNumber} sudah wujud dalam database` };
    }

    const now = new Date().toISOString();
    const newVehicle: VehicleCase = {
      ...data,
      id: `veh-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
      plateNumber: normalized, // auto uppercase
      normalizedPlate: normalized,
      createdAt: now,
      updatedAt: now,
      detectionCount: 0,
    };

    store.vehicles.unshift(newVehicle);
    store.auditLogs.unshift({
      id: `log-${Date.now()}`,
      action: 'CREATE',
      entityType: 'VEHICLE',
      entityId: newVehicle.id,
      newValue: newVehicle,
      createdAt: now,
    });

    saveStore(store);
    return { success: true, vehicle: newVehicle };
  }

  static updateVehicle(id: string, data: Partial<VehicleCase>): {
    success: boolean;
    vehicle?: VehicleCase;
    error?: string;
  } {
    const store = loadStore();
    const index = store.vehicles.findIndex((v) => v.id === id);
    if (index === -1) return { success: false, error: 'Kenderaan tidak ditemui' };

    const oldVehicle = store.vehicles[index];

    let normPlate = oldVehicle.normalizedPlate;
    if (data.plateNumber) {
      normPlate = normalizePlate(data.plateNumber);
      const duplicate = store.vehicles.find((v) => v.id !== id && v.normalizedPlate === normPlate);
      if (duplicate) {
        return { success: false, error: `Nombor plat ${data.plateNumber} sudah wujud` };
      }
    }

    const now = new Date().toISOString();
    const updated: VehicleCase = {
      ...oldVehicle,
      ...data,
      plateNumber: data.plateNumber ? normPlate : oldVehicle.plateNumber,
      normalizedPlate: normPlate,
      updatedAt: now,
    };

    store.vehicles[index] = updated;
    store.auditLogs.unshift({
      id: `log-${Date.now()}`,
      action: 'UPDATE',
      entityType: 'VEHICLE',
      entityId: id,
      previousValue: oldVehicle,
      newValue: updated,
      createdAt: now,
    });

    saveStore(store);
    return { success: true, vehicle: updated };
  }

  static deleteVehicle(id: string): { success: boolean; error?: string } {
    const store = loadStore();
    const index = store.vehicles.findIndex((v) => v.id === id);
    if (index === -1) return { success: false, error: 'Kenderaan tidak ditemui' };

    const removed = store.vehicles.splice(index, 1)[0];
    store.auditLogs.unshift({
      id: `log-${Date.now()}`,
      action: 'DELETE',
      entityType: 'VEHICLE',
      entityId: id,
      previousValue: removed,
      createdAt: new Date().toISOString(),
    });

    saveStore(store);
    return { success: true };
  }

  /**
   * Plate Matching Engine:
   * Returns Exact Match, Possible Match, or No Match
   */
  static searchPlate(
    rawInput: string,
    source: SearchSource = 'MANUAL',
    confidence: number = 1.0,
    charConfidences?: CharacterConfidence[]
  ): {
    matchType: MatchType;
    matchedVehicle: VehicleCase | null;
    possibleMatches: VehicleCase[];
    normalizedPlate: string;
    category?: PlateCategory;
  } {
    const store = loadStore();
    const evalRes = evaluateDatabaseMatch(
      rawInput,
      confidence,
      store.vehicles,
      charConfidences,
      store.settings.recognitionThreshold || 0.65
    );

    // Record search event
    const event: SearchEvent = {
      id: `srch-${Date.now()}-${Math.random().toString(36).substring(2, 5)}`,
      searchValue: rawInput,
      normalizedPlate: evalRes.normalizedPlate,
      matchType: evalRes.matchType,
      matchedVehicleId: evalRes.matchedVehicle?.id,
      source,
      confidence: evalRes.confidence,
      searchedAt: new Date().toISOString(),
    };
    store.searchEvents.unshift(event);
    saveStore(store);

    return {
      matchType: evalRes.matchType,
      matchedVehicle: evalRes.matchedVehicle,
      possibleMatches: evalRes.possibleMatches,
      normalizedPlate: evalRes.normalizedPlate,
      category: evalRes.category,
    };
  }

  static createScanEvent(data: Omit<ScanEvent, 'id' | 'detectedAt'>): {
    scanEvent: ScanEvent;
    isDuplicateSuppressed: boolean;
  } {
    const store = loadStore();
    const cooldownMs = (store.settings.duplicateCooldown || 30) * 1000;
    const now = new Date();
    const nowIso = now.toISOString();

    // Duplicate suppression check
    const recentRecentScan = store.scanEvents.find(
      (s) =>
        s.normalizedPlate === data.normalizedPlate &&
        now.getTime() - new Date(s.detectedAt).getTime() < cooldownMs
    );

    if (recentRecentScan) {
      return { scanEvent: recentRecentScan, isDuplicateSuppressed: true };
    }

    const scanEvent: ScanEvent = {
      ...data,
      id: `scan-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`,
      detectedAt: nowIso,
    };

    store.scanEvents.unshift(scanEvent);

    // Update vehicle detection count if matched
    if (data.matchedVehicleId) {
      const vIndex = store.vehicles.findIndex((v) => v.id === data.matchedVehicleId);
      if (vIndex !== -1) {
        store.vehicles[vIndex].lastDetectedAt = nowIso;
        store.vehicles[vIndex].detectionCount = (store.vehicles[vIndex].detectionCount || 0) + 1;
      }
    }

    saveStore(store);
    return { scanEvent, isDuplicateSuppressed: false };
  }

  static listScans(filters?: { matchType?: MatchType | 'ALL'; source?: SearchSource | 'ALL'; query?: string }): ScanEvent[] {
    const store = loadStore();
    let result = [...store.scanEvents];

    if (filters?.matchType && filters.matchType !== 'ALL') {
      result = result.filter((s) => s.matchType === filters.matchType);
    }

    if (filters?.source && filters.source !== 'ALL') {
      result = result.filter((s) => s.source === filters.source);
    }

    if (filters?.query) {
      const q = filters.query.toLowerCase();
      result = result.filter((s) => s.detectedPlate.toLowerCase().includes(q) || s.normalizedPlate.toLowerCase().includes(q));
    }

    return result.sort((a, b) => new Date(b.detectedAt).getTime() - new Date(a.detectedAt).getTime());
  }

  static listRecentSearches(limit: number = 10): SearchEvent[] {
    const store = loadStore();
    return store.searchEvents
      .slice(0, limit)
      .sort((a, b) => new Date(b.searchedAt).getTime() - new Date(a.searchedAt).getTime());
  }

  static confirmScan(id: string): boolean {
    const store = loadStore();
    const scan = store.scanEvents.find((s) => s.id === id);
    if (!scan) return false;

    scan.confirmed = true;
    store.auditLogs.unshift({
      id: `log-${Date.now()}`,
      action: 'CONFIRM_SCAN',
      entityType: 'SCAN',
      entityId: id,
      createdAt: new Date().toISOString(),
    });

    saveStore(store);
    return true;
  }

  static reportWrongScan(id: string): boolean {
    const store = loadStore();
    const scan = store.scanEvents.find((s) => s.id === id);
    if (!scan) return false;

    scan.reportedWrong = true;
    store.auditLogs.unshift({
      id: `log-${Date.now()}`,
      action: 'REPORT_WRONG',
      entityType: 'SCAN',
      entityId: id,
      createdAt: new Date().toISOString(),
    });

    saveStore(store);
    return true;
  }

  static clearScanHistory(): void {
    const store = loadStore();
    store.scanEvents = [];
    store.searchEvents = [];
    saveStore(store);
  }

  static getSettings(): ScannerSettings {
    const store = loadStore();
    return { ...INITIAL_SETTINGS, ...(store.settings || {}) };
  }

  static updateSettings(newSettings: Partial<ScannerSettings>): ScannerSettings {
    const store = loadStore();
    store.settings = { ...store.settings, ...newSettings };
    saveStore(store);
    return store.settings;
  }

  static resetDemoData(): void {
    const initialData: StorageSchema = {
      vehicles: INITIAL_VEHICLES,
      scanEvents: [],
      searchEvents: [],
      auditLogs: [],
      settings: INITIAL_SETTINGS,
    };
    saveStore(initialData);
  }
}
