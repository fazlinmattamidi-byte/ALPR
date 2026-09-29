import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PlateQRepository } from '../lib/db/repository';
import { parseAndValidateVehiclesCsv } from '../lib/utils/csv';

const CRUD_PLATE = 'TST8899';

beforeEach(() => {
  PlateQRepository.resetDemoData();
});

afterEach(() => {
  PlateQRepository.resetDemoData();
});

describe('PlateQ repository CRUD and operational flows', () => {
  it('creates, reads, updates, searches, and deletes vehicle cases', () => {
    const created = PlateQRepository.createVehicle({
      plateNumber: CRUD_PLATE,
      customerName: 'Test Customer',
      customerReference: 'CUST-CRUD',
      vehicleMake: 'Proton',
      vehicleModel: 'S70',
      vehicleColor: 'Silver',
      vehicleYear: 2025,
      vehicleType: 'Sedan',
      financeCompany: 'Maybank',
      outstandingAmount: 12500,
      caseReference: 'CRUD-001',
      status: 'ACTIVE',
      notes: 'CRUD smoke test',
    });

    expect(created.success).toBe(true);
    expect(created.vehicle?.normalizedPlate).toBe(CRUD_PLATE);
    expect(PlateQRepository.getVehicleById(created.vehicle!.id)?.plateNumber).toBe(CRUD_PLATE);
    expect(PlateQRepository.listVehicles({ query: 'crud-001' })).toHaveLength(1);

    const duplicate = PlateQRepository.createVehicle({
      plateNumber: CRUD_PLATE,
      customerName: 'Duplicate Customer',
      vehicleMake: 'Proton',
      vehicleModel: 'Saga',
      vehicleColor: 'White',
      financeCompany: 'Maybank',
      outstandingAmount: 9000,
      caseReference: 'CRUD-DUP',
      status: 'ACTIVE',
    });

    expect(duplicate.success).toBe(false);

    const updated = PlateQRepository.updateVehicle(created.vehicle!.id, {
      status: 'ON_HOLD',
      vehicleColor: 'Black',
    });

    expect(updated.success).toBe(true);
    expect(updated.vehicle?.status).toBe('ON_HOLD');
    expect(updated.vehicle?.vehicleColor).toBe('Black');

    const search = PlateQRepository.searchPlate(CRUD_PLATE, 'MANUAL', 0.94);
    expect(search.matchType).toBe('EXACT');
    expect(search.matchedVehicle?.id).toBe(created.vehicle!.id);

    expect(PlateQRepository.deleteVehicle(created.vehicle!.id).success).toBe(true);
    expect(PlateQRepository.getVehicleById(created.vehicle!.id)).toBeNull();
  });

  it('records scan events, suppresses cooldown duplicates, and updates scanner settings', () => {
    const created = PlateQRepository.createVehicle({
      plateNumber: CRUD_PLATE,
      customerName: 'Scan Customer',
      vehicleMake: 'Perodua',
      vehicleModel: 'Bezza',
      vehicleColor: 'White',
      financeCompany: 'CIMB',
      outstandingAmount: 18500,
      caseReference: 'SCAN-001',
      status: 'ACTIVE',
    });

    expect(created.success).toBe(true);

    const scan = PlateQRepository.createScanEvent({
      detectedPlate: CRUD_PLATE,
      normalizedPlate: CRUD_PLATE,
      confidence: 0.92,
      matchType: 'EXACT',
      matchedVehicleId: created.vehicle!.id,
      source: 'CAMERA',
      trackId: 'track-1',
    });

    expect(scan.isDuplicateSuppressed).toBe(false);
    expect(scan.scanEvent.detectedPlate).toBe(CRUD_PLATE);
    expect(PlateQRepository.getVehicleById(created.vehicle!.id)?.detectionCount).toBe(1);

    const duplicateScan = PlateQRepository.createScanEvent({
      detectedPlate: CRUD_PLATE,
      normalizedPlate: CRUD_PLATE,
      confidence: 0.91,
      matchType: 'EXACT',
      matchedVehicleId: created.vehicle!.id,
      source: 'CAMERA',
      trackId: 'track-2',
    });

    expect(duplicateScan.isDuplicateSuppressed).toBe(true);
    expect(PlateQRepository.listScans({ matchType: 'EXACT' })).toHaveLength(1);

    expect(PlateQRepository.confirmScan(scan.scanEvent.id)).toBe(true);
    expect(PlateQRepository.reportWrongScan(scan.scanEvent.id)).toBe(true);

    const settings = PlateQRepository.updateSettings({
      recognitionThreshold: 0.77,
      consensusVotes: 3,
    });
    expect(settings.recognitionThreshold).toBe(0.77);
    expect(PlateQRepository.getSettings().consensusVotes).toBe(3);
  });

  it('validates vehicle CSV imports with duplicate and invalid-row reporting', () => {
    const csv = [
      'Nombor Plat,Nama Pelanggan,Jenama,Model,Warna,Syarikat Kewangan,Jumlah Tunggakan,Rujukan Kes,Status,Nota',
      'ABC1234,Aminah,Perodua,Myvi,Blue,Maybank,12000,CSV-001,ACTIVE,Valid row',
      'ABC1234,Duplicate,Perodua,Axia,White,CIMB,10000,CSV-002,ACTIVE,Duplicate row',
      ',Missing Plate,Proton,Saga,Red,CIMB,8000,CSV-003,ACTIVE,Invalid row',
    ].join('\n');

    const result = parseAndValidateVehiclesCsv(csv, new Set());

    expect(result.totalRows).toBe(3);
    expect(result.validRows).toHaveLength(1);
    expect(result.validRows[0].plateNumber).toBe('ABC1234');
    expect(result.duplicateRows).toHaveLength(1);
    expect(result.invalidRows).toHaveLength(1);
  });
});
