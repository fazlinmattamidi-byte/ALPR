import Papa from 'papaparse';
import { VehicleCase, CaseStatus } from '../db/types';
import { normalizePlate } from '../anpr/normaliser';

export interface CsvImportRow {
  plateNumber?: string;
  customerName?: string;
  vehicleMake?: string;
  vehicleModel?: string;
  vehicleColor?: string;
  financeCompany?: string;
  outstandingAmount?: string | number;
  caseReference?: string;
  status?: string;
  notes?: string;
}

export interface CsvValidationResult {
  totalRows: number;
  validRows: Array<Omit<VehicleCase, 'id' | 'createdAt' | 'updatedAt' | 'normalizedPlate'>>;
  invalidRows: Array<{ rowNumber: number; data: CsvImportRow; reason: string }>;
  duplicateRows: Array<{ rowNumber: number; plateNumber: string; reason: string }>;
}

type CsvImportRecord = CsvImportRow & Record<string, string | number | undefined>;

function getCsvValue(row: CsvImportRecord, primaryKey: keyof CsvImportRow, fallbackKey?: string): string {
  const value = row[primaryKey] ?? (fallbackKey ? row[fallbackKey] : undefined) ?? '';
  return String(value);
}

export function parseAndValidateVehiclesCsv(
  csvContent: string,
  existingNormalizedPlates: Set<string>
): CsvValidationResult {
  const parsed = Papa.parse<CsvImportRow>(csvContent, {
    header: true,
    skipEmptyLines: true,
  });

  const validRows: Array<Omit<VehicleCase, 'id' | 'createdAt' | 'updatedAt' | 'normalizedPlate'>> = [];
  const invalidRows: Array<{ rowNumber: number; data: CsvImportRow; reason: string }> = [];
  const duplicateRows: Array<{ rowNumber: number; plateNumber: string; reason: string }> = [];

  const seenInCsv = new Set<string>();

  parsed.data.forEach((row, index) => {
    const rowNum = index + 2; // header is row 1
    const rowRecord = row as CsvImportRecord;

    const rawPlate = getCsvValue(rowRecord, 'plateNumber', 'Nombor Plat');
    const normalized = normalizePlate(rawPlate);

    if (!normalized) {
      invalidRows.push({
        rowNumber: rowNum,
        data: row,
        reason: 'Nombor plat tidak sah atau kosong',
      });
      return;
    }

    if (seenInCsv.has(normalized)) {
      duplicateRows.push({
        rowNumber: rowNum,
        plateNumber: rawPlate,
        reason: 'Duplikasi nombor plat dalam fail CSV',
      });
      return;
    }

    if (existingNormalizedPlates.has(normalized)) {
      duplicateRows.push({
        rowNumber: rowNum,
        plateNumber: rawPlate,
        reason: `Nombor plat ${normalized} sudah wujud dalam database`,
      });
      return;
    }

    const customerName = getCsvValue(rowRecord, 'customerName', 'Nama Pelanggan').trim() || 'N/A';
    const vehicleMake = getCsvValue(rowRecord, 'vehicleMake', 'Jenama').trim() || 'Unknown';
    const vehicleModel = getCsvValue(rowRecord, 'vehicleModel', 'Model').trim() || 'Unknown';
    const vehicleColor = getCsvValue(rowRecord, 'vehicleColor', 'Warna').trim() || 'Unknown';
    const financeCompany = getCsvValue(rowRecord, 'financeCompany', 'Syarikat Kewangan').trim() || 'N/A';
    const caseReference = getCsvValue(rowRecord, 'caseReference', 'Rujukan Kes').trim() || `REF-${Date.now()}`;
    const notes = getCsvValue(rowRecord, 'notes', 'Nota').trim();

    const rawAmount = getCsvValue(rowRecord, 'outstandingAmount', 'Jumlah Tunggakan') || '0';
    const amountNum = parseFloat(String(rawAmount).replace(/[^0-9.]/g, ''));

    if (isNaN(amountNum) || amountNum < 0) {
      invalidRows.push({
        rowNumber: rowNum,
        data: row,
        reason: 'Jumlah tunggakan tidak sah',
      });
      return;
    }

    const statusRaw = (row.status || 'ACTIVE').toUpperCase().trim();
    const validStatuses: CaseStatus[] = ['ACTIVE', 'ON_HOLD', 'RECOVERED', 'CLOSED'];
    const status: CaseStatus = validStatuses.includes(statusRaw as CaseStatus)
      ? (statusRaw as CaseStatus)
      : 'ACTIVE';

    seenInCsv.add(normalized);

    validRows.push({
      plateNumber: normalized,
      customerName,
      vehicleMake,
      vehicleModel,
      vehicleColor,
      financeCompany,
      outstandingAmount: amountNum,
      caseReference,
      status,
      notes,
    });
  });

  return {
    totalRows: parsed.data.length,
    validRows,
    invalidRows,
    duplicateRows,
  };
}

export function generateVehiclesCsvTemplate(): string {
  const headers = [
    'plateNumber',
    'customerName',
    'vehicleMake',
    'vehicleModel',
    'vehicleColor',
    'financeCompany',
    'outstandingAmount',
    'caseReference',
    'status',
    'notes',
  ];
  const sampleRow = [
    'ANN7569',
    'Ahmad',
    'Perodua',
    'Bezza',
    'White',
    'CIMB',
    '15000.00',
    'CIMB001',
    'ACTIVE',
    'Priority repossession case',
  ];

  return Papa.unparse([headers, sampleRow]);
}

export function exportVehiclesToCsv(vehicles: VehicleCase[]): string {
  const data = vehicles.map((v) => ({
    plateNumber: v.plateNumber,
    customerName: v.customerName,
    vehicleMake: v.vehicleMake,
    vehicleModel: v.vehicleModel,
    vehicleColor: v.vehicleColor,
    financeCompany: v.financeCompany,
    outstandingAmount: v.outstandingAmount,
    caseReference: v.caseReference,
    status: v.status,
    notes: v.notes || '',
    createdAt: v.createdAt,
  }));

  return Papa.unparse(data);
}
