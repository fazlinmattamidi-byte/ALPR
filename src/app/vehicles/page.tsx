'use client';

import React, { useState } from 'react';
import { useStorage } from '@/context/StorageContext';
import { useLanguage } from '@/context/LanguageContext';
import { useAuth } from '@/context/AuthContext';
import { formatMYR, cleanPlateNumber, downloadCSV } from '@/lib/utils';
import { Vehicle, VehiclePriority, VehicleStatus } from '@/types';
import {
  Plus,
  Search,
  Upload,
  Download,
  Edit2,
  Trash2,
  X,
  FileSpreadsheet,
  ChevronLeft,
  ChevronRight,
  FileText,
} from 'lucide-react';

const BRAND_OPTIONS = [
  'Perodua',
  'Proton',
  'Toyota',
  'Honda',
  'BYD',
  'Chery',
  'Tesla',
  'GWM / Ora',
  'Mazda',
  'Nissan',
  'BMW',
  'Mercedes-Benz',
  'Ford',
  'Smart',
  'Volvo',
  'Hyundai',
  'Kia',
  'Yamaha',
  'Modenas',
  'Honda (Motorcycle)',
  'Other',
];

const MODEL_MAP: Record<string, string[]> = {
  Perodua: ['Bezza', 'Myvi', 'Axia', 'Ativa', 'Alza', 'Aruz', 'Nexis (D66B)', 'EM-O EV', 'Viva', 'Other'],
  Proton: ['X50', 'X70', 'X90', 'S70', 'e.MAS 7 (EV)', 'Saga', 'Persona', 'Iriz', 'Exora', 'Other'],
  Toyota: ['Hilux', 'Vios', 'Yaris', 'Corolla Cross', 'Camry', 'Innova Zenix', 'Veloz', 'Fortuner', 'Alphard', 'Vellfire', 'bZ4X (EV)', 'Other'],
  Honda: ['Civic', 'City', 'City Hatchback', 'HR-V', 'CR-V', 'WR-V', 'ZR-V', 'Accord', 'e:N1 (EV)', 'Other'],
  BYD: ['Atto 3', 'Dolphin', 'Seal', 'Sealion 7', 'M6 (EV MPV)', 'Other'],
  Chery: ['Omoda 5', 'Tiggo 8 Pro', 'Tiggo 7 Pro', 'Omoda E5 (EV)', 'Other'],
  Tesla: ['Model 3 Highlands', 'Model Y', 'Other'],
  'GWM / Ora': ['Ora Good Cat', 'Ora 07', 'Tank 300', 'Haval H6 HEV', 'Other'],
  Mazda: ['CX-5', 'CX-30', 'CX-60', 'CX-3', 'Mazda 2', 'Mazda 3', 'MX-30 (EV)', 'Other'],
  Nissan: ['Navara', 'Serena e-POWER', 'Almera Turbo', 'Kicks e-POWER', 'Leaf (EV)', 'Other'],
  BMW: ['320i', '330i', '530i', 'i4 (EV)', 'iX3 (EV)', 'iX (EV)', 'X1', 'X3', 'X5', 'Other'],
  'Mercedes-Benz': ['C200', 'C300', 'E200', 'GLC250', 'EQE (EV)', 'EQS (EV)', 'A200', 'Other'],
  Ford: ['Ranger', 'Ranger Raptor', 'Everest', 'Mustang Mach-E', 'Other'],
  Smart: ['smart #1', 'smart #3', 'Other'],
  Volvo: ['EX30 (EV)', 'XC60', 'XC90', 'XC40 Recharge', 'Other'],
  Hyundai: ['Ioniq 5', 'Ioniq 6', 'Creta', 'Santa Fe', 'Other'],
  Kia: ['EV6', 'EV9', 'Carnival', 'Seltos', 'Other'],
  Yamaha: ['Y15ZR', 'Y16ZR', 'NVX 155', '135LC', 'NMAX 155', 'XMAX 250', 'Other'],
  Modenas: ['Kriss 110', 'Pulsar NS200', 'Ninja 250', 'Other'],
  'Honda (Motorcycle)': ['RSX 150', 'Vario 160', 'ADV 160', 'EX5', 'Wave Alpha', 'Other'],
};

const COLOUR_OPTIONS = [
  'White',
  'Black',
  'Silver',
  'Grey',
  'Red',
  'Blue',
  'Amber / Gold',
  'Green',
  'Brown',
  'Yellow',
  'Other',
];

const FINANCE_OPTIONS = [
  'Maybank / Maybank Islamic',
  'CIMB Bank / CIMB Islamic',
  'Public Bank / Public Islamic',
  'Hong Leong Bank / HLB Islamic',
  'Bank Islam Malaysia',
  'RHB Bank / RHB Islamic',
  'AmBank / AmBank Islamic',
  'Bank Simpanan Nasional (BSN)',
  'Affin Bank / Affin Islamic',
  'Bank Muamalat',
  'Aeon Credit / Aeon Bank',
  'MBSB Bank',
  'Toyota Capital Malaysia',
  'BMW Credit Malaysia',
  'Mercedes-Benz Services',
  'Chailease Berjaya Credit',
  'ELK-Desa Capital',
  'Sabah Credit Corporation',
  'Sarawak Credit Corporation',
  'Affinity Capital',
  'Other',
];

type VehicleFormStep = 'CASE' | 'CUSTOMER' | 'VEHICLE';

export default function VehiclesPage() {
  const { vehicles, addVehicle, updateVehicle, deleteVehicle, importVehiclesCSV, exportVehiclesCSV } = useStorage();
  const { t, language } = useLanguage();
  const { canManageVehicles, canManageSystem } = useAuth();
  const canModifyVehicles = canManageVehicles;
  const canAddVehicle = canModifyVehicles;
  const showActionColumn = canModifyVehicles;

  const [searchTerm, setSearchTerm] = useState('');
  const [statusFilter, setStatusFilter] = useState<string>('ALL');

  // Pagination State
  const [currentPage, setCurrentPage] = useState<number>(1);
  const [pageSize, setPageSize] = useState<number>(10);

  // Modal states
  const [isAddModalOpen, setIsAddModalOpen] = useState(false);
  const [editingVehicle, setEditingVehicle] = useState<Vehicle | null>(null);
  const [deletingVehicleId, setDeletingVehicleId] = useState<string | null>(null);
  const [isImportModalOpen, setIsImportModalOpen] = useState(false);
  const [vehicleFormStep, setVehicleFormStep] = useState<VehicleFormStep>('CASE');
  const [csvText, setCsvText] = useState('');

  // Form Base State
  const [plateInput, setPlateInput] = useState('');
  const [customerNameInput, setCustomerNameInput] = useState('');
  const [customerIdInput, setCustomerIdInput] = useState('');
  const [phoneInput, setPhoneInput] = useState('+60 12-345 6789');
  const [yearInput, setYearInput] = useState(2022);
  const [outstandingInput, setOutstandingInput] = useState(15000);
  const [referenceInput, setReferenceInput] = useState('');
  const [priorityInput, setPriorityInput] = useState<VehiclePriority>('HIGH');
  const [statusInput, setStatusInput] = useState<VehicleStatus>('ACTIVE');
  const [remarkInput, setRemarkInput] = useState('');

  // Dropdown & Custom Field States
  const [selectedBrand, setSelectedBrand] = useState('Perodua');
  const [customBrand, setCustomBrand] = useState('');

  const [selectedModel, setSelectedModel] = useState('Bezza');
  const [customModel, setCustomModel] = useState('');

  const [selectedColour, setSelectedColour] = useState('White');
  const [customColour, setCustomColour] = useState('');

  const [selectedFinance, setSelectedFinance] = useState('CIMB Bank');
  const [customFinance, setCustomFinance] = useState('');

  const openAddModal = () => {
    if (!canAddVehicle) return;
    setPlateInput('');
    setCustomerNameInput('');
    setCustomerIdInput(`CUST-${Math.floor(100 + Math.random() * 900)}`);
    setPhoneInput('+60 12-345 6789');
    setYearInput(2022);
    setOutstandingInput(15000);
    setReferenceInput(`REF-${Math.floor(1000 + Math.random() * 9000)}`);
    setPriorityInput('HIGH');
    setStatusInput('ACTIVE');
    setRemarkInput('New repossession entry');

    setSelectedBrand('Perodua');
    setCustomBrand('');
    setSelectedModel('Bezza');
    setCustomModel('');
    setSelectedColour('White');
    setCustomColour('');
    setSelectedFinance('CIMB Bank');
    setCustomFinance('');

    setEditingVehicle(null);
    setVehicleFormStep('CASE');
    setIsAddModalOpen(true);
  };

  const openEditModal = (v: Vehicle) => {
    if (!canModifyVehicles) return;
    setEditingVehicle(v);
    setPlateInput(v.plate);
    setCustomerNameInput(v.customerName);
    setCustomerIdInput(v.customerId);
    setPhoneInput(v.phone);
    setYearInput(v.year);
    setOutstandingInput(v.outstandingAmount);
    setReferenceInput(v.reference);
    setPriorityInput(v.priority);
    setStatusInput(v.status);
    setRemarkInput(v.remark);

    // Brand matching
    if (BRAND_OPTIONS.includes(v.brand)) {
      setSelectedBrand(v.brand);
      setCustomBrand('');
    } else {
      setSelectedBrand('Other');
      setCustomBrand(v.brand);
    }

    // Model matching
    const knownModels = MODEL_MAP[v.brand] || [];
    if (knownModels.includes(v.model)) {
      setSelectedModel(v.model);
      setCustomModel('');
    } else {
      setSelectedModel('Other');
      setCustomModel(v.model);
    }

    // Colour matching
    if (COLOUR_OPTIONS.includes(v.colour)) {
      setSelectedColour(v.colour);
      setCustomColour('');
    } else {
      setSelectedColour('Other');
      setCustomColour(v.colour);
    }

    // Finance matching
    if (FINANCE_OPTIONS.includes(v.financeCompany)) {
      setSelectedFinance(v.financeCompany);
      setCustomFinance('');
    } else {
      setSelectedFinance('Other');
      setCustomFinance(v.financeCompany);
    }

    setVehicleFormStep('CASE');
    setIsAddModalOpen(true);
  };

  const handleSaveForm = (e: React.FormEvent) => {
    e.preventDefault();
    if ((editingVehicle && !canModifyVehicles) || (!editingVehicle && !canAddVehicle)) return;
    if (!plateInput.trim() || !customerNameInput.trim()) return;

    const finalBrand = selectedBrand === 'Other' ? customBrand || 'Custom Brand' : selectedBrand;
    const finalModel = selectedModel === 'Other' ? customModel || 'Custom Model' : selectedModel;
    const finalColour = selectedColour === 'Other' ? customColour || 'Custom Colour' : selectedColour;
    const finalFinance = selectedFinance === 'Other' ? customFinance || 'Custom Finance' : selectedFinance;

    const vehicleData = {
      plate: cleanPlateNumber(plateInput),
      customerName: customerNameInput,
      customerId: customerIdInput,
      phone: phoneInput,
      brand: finalBrand,
      model: finalModel,
      colour: finalColour,
      year: yearInput,
      financeCompany: finalFinance,
      outstandingAmount: outstandingInput,
      reference: referenceInput,
      priority: priorityInput,
      status: statusInput,
      remark: remarkInput,
    };

    if (editingVehicle) {
      updateVehicle({
        ...editingVehicle,
        ...vehicleData,
      });
    } else {
      addVehicle(vehicleData);
    }
    setIsAddModalOpen(false);
  };

  const handleDeleteConfirm = () => {
    if (!canModifyVehicles) return;
    if (deletingVehicleId) {
      deleteVehicle(deletingVehicleId);
      setDeletingVehicleId(null);
    }
  };

  const handleCsvImportSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!canManageSystem) return;
    if (!csvText.trim()) return;
    const count = importVehiclesCSV(csvText);
    alert(`Successfully imported ${count} vehicles into LocalStorage database!`);
    setCsvText('');
    setIsImportModalOpen(false);
  };

  const downloadCSVTemplate = () => {
    const template = `Plate,Customer,Customer_ID,Phone,Brand,Model,Colour,Year,Finance,Outstanding,Reference,Priority,Status,Remark\nANN7569,Ahmad,CUST-001,+60 12-345 6789,Perodua,Bezza,White,2021,CIMB Bank,15000,CIMB001,HIGH,ACTIVE,Priority repossession case\nABC1234,Muthu,CUST-002,+60 16-889 1234,Yamaha,Y15ZR,Blue,2022,Aeon Credit,6800,AEON-M01,MEDIUM,ACTIVE,Overdue installment 5 months\nQAA1234,Abang Johari,CUST-004,+60 13-801 9988,Ford,Ranger,Silver,2023,Bank Islam,31000,BIMB-101,HIGH,ACTIVE,Sarawak state territory vehicle`;
    downloadCSV('track_vehicle_import_template.csv', template);
  };

  // Filtered dataset
  const filteredVehicles = vehicles.filter((v) => {
    const p = cleanPlateNumber(v.plate);
    const c = v.customerName.toLowerCase();
    const ref = v.reference.toLowerCase();
    const q = searchTerm.toLowerCase();

    const matchesSearch = p.includes(cleanPlateNumber(searchTerm)) || c.includes(q) || ref.includes(q);
    const matchesStatus = statusFilter === 'ALL' || v.status === statusFilter;

    return matchesSearch && matchesStatus;
  });

  // Pagination Math
  const totalItems = filteredVehicles.length;
  const totalPages = Math.ceil(totalItems / pageSize) || 1;
  const safeCurrentPage = Math.min(currentPage, totalPages);
  const startIndex = (safeCurrentPage - 1) * pageSize;
  const paginatedVehicles = filteredVehicles.slice(startIndex, startIndex + pageSize);

  // Dynamic model options based on selected brand
  const currentModelOptions = MODEL_MAP[selectedBrand] || ['Other'];
  const vehicleFormSteps = [
    { id: 'CASE', label: language === 'BM' ? 'Kes' : 'Case' },
    { id: 'CUSTOMER', label: language === 'BM' ? 'Pelanggan' : 'Customer' },
    { id: 'VEHICLE', label: language === 'BM' ? 'Kenderaan' : 'Vehicle' },
  ] satisfies Array<{ id: VehicleFormStep; label: string }>;
  const vehicleFormStepIndex = vehicleFormSteps.findIndex((step) => step.id === vehicleFormStep);
  const isFirstVehicleFormStep = vehicleFormStepIndex === 0;
  const isLastVehicleFormStep = vehicleFormStepIndex === vehicleFormSteps.length - 1;
  const canContinueVehicleForm =
    vehicleFormStep === 'CASE'
      ? Boolean(plateInput.trim())
      : vehicleFormStep === 'CUSTOMER'
      ? Boolean(customerNameInput.trim())
      : true;
  const goToPreviousVehicleFormStep = () => {
    setVehicleFormStep(vehicleFormSteps[Math.max(vehicleFormStepIndex - 1, 0)].id);
  };
  const goToNextVehicleFormStep = () => {
    setVehicleFormStep(vehicleFormSteps[Math.min(vehicleFormStepIndex + 1, vehicleFormSteps.length - 1)].id);
  };

  return (
    <div className="space-y-5 sm:space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 sm:gap-4">
        <div>
          <h1 className="text-2xl sm:text-2xl font-black text-white tracking-wide leading-tight">
            {t('manageVehiclesTitle')}
          </h1>
        </div>

        <div className="grid grid-cols-3 gap-2 sm:flex sm:flex-wrap sm:items-center">
          {canManageSystem && (
            <button
              onClick={() => setIsImportModalOpen(true)}
              className="px-3 py-2.5 sm:px-3.5 sm:py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-bold border border-slate-700 flex items-center gap-2 transition-all justify-center"
            >
              <Upload className="w-3.5 h-3.5 sm:w-4 sm:h-4 text-cyan-400" />
              <span className="hidden min-[420px]:inline sm:inline">{t('importCsv')}</span>
            </button>
          )}

          <button
            onClick={exportVehiclesCSV}
            className="px-3 py-2.5 sm:px-3.5 sm:py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-bold border border-slate-700 flex items-center gap-2 transition-all justify-center"
          >
            <Download className="w-3.5 h-3.5 sm:w-4 sm:h-4 text-emerald-400" />
            <span className="hidden min-[420px]:inline sm:inline">{t('exportCsv')}</span>
          </button>

          {canAddVehicle && (
            <button
              onClick={openAddModal}
              className="px-3 py-2.5 sm:py-2 rounded-xl bg-cyan-600 hover:bg-cyan-500 text-white font-black text-xs uppercase tracking-wider flex items-center gap-2 shadow-lg shadow-cyan-500/20 transition-all sm:w-auto justify-center"
            >
              <Plus className="w-4 h-4" />
              <span className="hidden min-[420px]:inline sm:inline">{t('addVehicle')}</span>
            </button>
          )}
        </div>
      </div>

      {/* Filter & Search Bar */}
      <div className="bg-slate-900/90 border border-slate-800 rounded-2xl p-3 sm:p-4 shadow-xl backdrop-blur-md flex flex-col md:flex-row items-center gap-2.5 sm:gap-3">
        <div className="relative flex-1 w-full">
          <Search className="w-4 h-4 text-slate-500 absolute left-3.5 top-3.5 sm:top-3" />
          <input
            type="text"
            value={searchTerm}
            onChange={(e) => {
              setSearchTerm(e.target.value);
              setCurrentPage(1);
            }}
            placeholder={t('searchVehiclePlaceholder')}
            className="w-full bg-slate-950 border border-slate-800 rounded-xl pl-10 pr-4 py-3 sm:py-2 text-sm sm:text-xs text-white placeholder:text-slate-500 focus:outline-none focus:border-cyan-500"
          />
        </div>

        <div className="flex items-center gap-2 w-full md:w-auto">
          {/* Status Filter */}
          <select
            value={statusFilter}
            onChange={(e) => {
              setStatusFilter(e.target.value);
              setCurrentPage(1);
            }}
            className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-3 sm:py-2 text-sm sm:text-xs text-slate-300 focus:outline-none cursor-pointer flex-1 md:flex-none"
          >
            <option value="ALL">{t('filterByStatus')}</option>
            <option value="ACTIVE">{t('statusActive')}</option>
            <option value="FLAGGED">{t('statusFlagged')}</option>
            <option value="PENDING">{t('statusPending')}</option>
            <option value="CLEARED">{t('statusCleared')}</option>
          </select>
        </div>
      </div>

      {/* Vehicle Data Container */}
      <div className="bg-slate-900/90 border border-slate-800 rounded-2xl shadow-xl overflow-hidden flex flex-col justify-between">
        {/* Mobile View: Vehicle Cards */}
        <div className="sm:hidden p-3 space-y-2.5">
          {paginatedVehicles.length > 0 ? (
            paginatedVehicles.map((v) => (
              <div key={v.id} className="p-3.5 rounded-xl bg-slate-950/80 border border-slate-800 space-y-2.5">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <span className="block truncate font-mono font-black text-lg leading-none text-cyan-300">
                      {v.plate}
                    </span>
                    {v.lastSeenAt && (
                      <div className="text-[10px] font-mono text-emerald-400 mt-1 flex items-center gap-1">
                        <span className="w-1.5 h-1.5 rounded-full bg-emerald-400"></span>
                        <span>{language === 'BM' ? 'Dikesan' : 'Seen'}: {new Date(v.lastSeenAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                        {v.lastSeenCamera && <span className="text-slate-400">({v.lastSeenCamera})</span>}
                      </div>
                    )}
                    <div className="mt-1 text-sm font-bold text-white leading-tight truncate">{v.brand} {v.model}</div>
                    <div className="text-[11px] text-slate-400">{v.colour} ({v.year})</div>
                  </div>
                  <div className="flex shrink-0 flex-col items-end gap-1">
                    <span
                      className={`inline-flex items-center justify-center rounded-md px-2 py-1 text-[10px] font-black uppercase text-center ${
                        v.priority === 'HIGH'
                          ? 'bg-red-950/70 text-red-300 border border-red-800'
                        : v.priority === 'MEDIUM'
                          ? 'bg-amber-950/70 text-amber-300 border border-amber-800'
                          : 'bg-cyan-950/60 text-cyan-300 border border-cyan-800'
                      }`}
                    >
                      {v.priority === 'HIGH'
                        ? t('priorityHigh')
                        : v.priority === 'MEDIUM'
                        ? t('priorityMedium')
                        : t('priorityLow')}
                    </span>
                    <span
                      className={`inline-flex items-center justify-center rounded-md px-2 py-1 text-[10px] font-bold uppercase text-center whitespace-nowrap ${
                        v.status === 'ACTIVE'
                          ? 'bg-slate-900 text-slate-300 border border-slate-700'
                          : v.status === 'FLAGGED'
                          ? 'bg-red-950/70 text-red-300 border border-red-800'
                          : v.status === 'PENDING'
                          ? 'bg-amber-950/60 text-amber-300 border border-amber-800'
                          : 'bg-slate-900 text-emerald-300 border border-slate-700'
                      }`}
                    >
                      {v.status === 'ACTIVE'
                        ? t('statusActive')
                        : v.status === 'FLAGGED'
                        ? t('statusFlagged')
                        : v.status === 'PENDING'
                        ? t('statusPending')
                        : t('statusCleared')}
                    </span>
                  </div>
                </div>

                <div className="flex items-start justify-between gap-3 text-xs pt-2.5 border-t border-slate-800/60">
                  <span className="min-w-0 text-slate-400 leading-snug">{v.financeCompany}</span>
                  <span className="shrink-0 font-mono font-bold text-slate-200 text-right">{formatMYR(v.outstandingAmount)}</span>
                </div>

                {canModifyVehicles && (
                  <div className="grid grid-cols-2 gap-2 pt-1.5 border-t border-slate-800/40">
                    <button
                      onClick={() => openEditModal(v)}
                      className="p-2.5 rounded-lg bg-slate-800 text-cyan-400 hover:bg-slate-700 text-xs font-bold flex items-center justify-center"
                      aria-label={t('editVehicle')}
                      title={t('editVehicle')}
                    >
                      <Edit2 className="w-3.5 h-3.5" />
                    </button>
                    <button
                      onClick={() => setDeletingVehicleId(v.id)}
                      className="p-2.5 rounded-lg bg-red-950/80 text-red-400 hover:bg-red-900 text-xs font-bold flex items-center justify-center"
                      aria-label={t('deleteVehicle')}
                      title={t('deleteVehicle')}
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                )}
              </div>
            ))
          ) : (
            <div className="py-6 text-center text-xs text-slate-500">{t('noVehiclesFound')}</div>
          )}
        </div>

        {/* Desktop View: Table */}
        <div className="hidden sm:block overflow-x-auto">
          <table className={`w-full text-left text-xs ${showActionColumn ? 'min-w-[800px]' : 'min-w-[680px]'}`}>
            <thead className="bg-slate-950/90 text-slate-400 uppercase font-mono text-[10px] border-b border-slate-800 whitespace-nowrap">
              <tr>
                <th className="py-3.5 px-4">{t('plateNumber')}</th>
                <th className="py-3.5 px-4">{t('vehicleModelHeader')}</th>
                <th className="py-3.5 px-4">{t('financeCompany')}</th>
                <th className="py-3.5 px-4">{t('outstandingHeader')}</th>
                <th className="py-3.5 px-4 text-center">{t('priorityHeader')}</th>
                <th className="py-3.5 px-4 text-center">{t('statusCase')}</th>
                {showActionColumn && <th className="py-3.5 px-4 text-right">{t('actionsHeader')}</th>}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/60 whitespace-nowrap">
              {paginatedVehicles.length > 0 ? (
                paginatedVehicles.map((v) => (
                  <tr key={v.id} className="hover:bg-slate-800/40 transition-colors">
                    <td className="py-3 px-4 font-mono">
                      <div className="font-black text-sm text-cyan-400">{v.plate}</div>
                      {v.lastSeenAt && (
                        <div className="text-[9px] text-emerald-400 mt-0.5 flex items-center gap-1">
                          <span className="w-1.5 h-1.5 rounded-full bg-emerald-400"></span>
                          <span>{new Date(v.lastSeenAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                          {v.lastSeenCamera && <span className="text-slate-400">({v.lastSeenCamera})</span>}
                        </div>
                      )}
                    </td>
                    <td className="py-3 px-4">
                      <div className="font-semibold text-slate-200">
                        {v.brand} {v.model}
                      </div>
                      <div className="text-[10px] text-slate-400">
                        {v.colour} ({v.year})
                      </div>
                    </td>
                    <td className="py-3 px-4 text-slate-300 font-medium">{v.financeCompany}</td>
                    <td className="py-3 px-4 font-mono font-semibold text-slate-200">
                      {formatMYR(v.outstandingAmount)}
                    </td>
                    <td className="py-3 px-4 text-center">
                      <span
                        className={`inline-flex items-center justify-center w-24 h-6 rounded-md text-[9px] font-bold uppercase text-center border ${
                          v.priority === 'HIGH'
                            ? 'bg-red-950/70 text-red-300 border-red-800'
                          : v.priority === 'MEDIUM'
                            ? 'bg-amber-950/70 text-amber-300 border-amber-800'
                            : 'bg-cyan-950/60 text-cyan-300 border-cyan-800'
                        }`}
                      >
                        {v.priority === 'HIGH'
                          ? t('priorityHigh')
                          : v.priority === 'MEDIUM'
                          ? t('priorityMedium')
                          : t('priorityLow')}
                      </span>
                    </td>
                    <td className="py-3 px-4 text-center">
                      <span
                        className={`inline-flex items-center justify-center w-36 h-6.5 rounded-md text-[10px] font-bold uppercase text-center whitespace-nowrap border ${
                          v.status === 'ACTIVE'
                            ? 'bg-cyan-950/70 text-cyan-300 border-cyan-800'
                          : v.status === 'FLAGGED'
                            ? 'bg-red-950/70 text-red-300 border-red-800'
                          : v.status === 'PENDING'
                            ? 'bg-amber-950/70 text-amber-300 border-amber-800'
                            : 'bg-emerald-950/60 text-emerald-300 border-emerald-800'
                        }`}
                      >
                        {v.status === 'ACTIVE'
                          ? t('statusActive')
                          : v.status === 'FLAGGED'
                          ? t('statusFlagged')
                          : v.status === 'PENDING'
                          ? t('statusPending')
                          : t('statusCleared')}
                      </span>
                    </td>
                    {showActionColumn && (
                      <td className="py-3 px-4 text-right">
                        <div className="flex items-center justify-end gap-1.5">
                          <button
                            onClick={() => openEditModal(v)}
                            className="p-1.5 rounded-lg bg-slate-800/70 hover:bg-slate-700 border border-slate-700/60 text-slate-300 hover:text-white transition-all cursor-pointer"
                            title="Edit Vehicle"
                          >
                            <Edit2 className="w-3.5 h-3.5" />
                          </button>
                          <button
                            onClick={() => setDeletingVehicleId(v.id)}
                            className="p-1.5 rounded-lg bg-slate-800/70 hover:bg-slate-700 border border-slate-700/60 text-slate-300 hover:text-white transition-all cursor-pointer"
                            title="Delete Vehicle"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      </td>
                    )}
                  </tr>
                ))
              ) : (
                <tr>
                  <td colSpan={showActionColumn ? 7 : 6} className="py-8 text-center text-slate-500">
                    No vehicles found matching search criteria.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        {/* Pagination & Rows Selector Footer */}
        <div className="px-4 py-3 bg-slate-950/90 border-t border-slate-800 flex flex-col sm:flex-row items-center justify-between gap-3 text-xs">
          {/* Rows Per Page Dropdown */}
          <div className="hidden sm:flex items-center gap-2 text-slate-400">
            <span>Show per page:</span>
            <select
              value={pageSize}
              onChange={(e) => {
                setPageSize(Number(e.target.value));
                setCurrentPage(1);
              }}
              className="bg-slate-900 border border-slate-800 rounded-lg px-2 py-1 text-xs text-white focus:outline-none cursor-pointer font-mono"
            >
              <option value={10}>10 rows</option>
              <option value={20}>20 rows</option>
              <option value={50}>50 rows</option>
            </select>
          </div>

          {/* Record Counter */}
          <div className="hidden sm:block text-slate-400 font-mono text-[11px]">
            Showing <strong className="text-cyan-400">{totalItems > 0 ? startIndex + 1 : 0}</strong> to{' '}
            <strong className="text-cyan-400">{Math.min(startIndex + pageSize, totalItems)}</strong> of{' '}
            <strong className="text-white">{totalItems}</strong> records
          </div>

          {/* Page Controls */}
          <div className="flex w-full items-center justify-between gap-1.5 sm:w-auto sm:justify-start">
            <button
              onClick={() => setCurrentPage((p) => Math.max(p - 1, 1))}
              disabled={safeCurrentPage === 1}
              className="p-1.5 rounded-lg bg-slate-900 border border-slate-800 text-slate-300 hover:bg-slate-800 disabled:opacity-40 disabled:cursor-not-allowed transition-all"
            >
              <ChevronLeft className="w-4 h-4" />
            </button>

            <span className="px-3 py-1 font-mono text-xs text-cyan-300 font-bold bg-cyan-950/80 border border-cyan-800/80 rounded-lg">
              Page {safeCurrentPage} of {totalPages}
            </span>

            <button
              onClick={() => setCurrentPage((p) => Math.min(p + 1, totalPages))}
              disabled={safeCurrentPage === totalPages}
              className="p-1.5 rounded-lg bg-slate-900 border border-slate-800 text-slate-300 hover:bg-slate-800 disabled:opacity-40 disabled:cursor-not-allowed transition-all"
            >
              <ChevronRight className="w-4 h-4" />
            </button>
          </div>
        </div>
      </div>

      {/* ADD / EDIT VEHICLE MODAL */}
      {isAddModalOpen && (
        <div className="fixed inset-0 z-50 bg-slate-950/80 backdrop-blur-md flex items-center justify-center p-3 sm:p-4">
          <div className="vehicle-form-modal flex h-[calc(100dvh-1.5rem)] max-h-[640px] w-full max-w-lg flex-col overflow-hidden rounded-2xl border border-cyan-900/50 bg-slate-900 p-4 shadow-2xl sm:block sm:h-auto sm:max-h-[90vh] sm:overflow-y-auto sm:p-6">
            <div className="flex shrink-0 items-center justify-between border-b border-slate-800 pb-3">
              <h2 className="text-lg sm:text-lg font-bold text-white">
                {editingVehicle ? t('editVehicle') : t('addVehicle')}
              </h2>
              <button
                onClick={() => setIsAddModalOpen(false)}
                className="p-1 rounded-lg hover:bg-slate-800 text-slate-400"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <form onSubmit={handleSaveForm} className="flex min-h-0 flex-1 flex-col pt-3 sm:hidden">
              <div className="grid grid-cols-3 gap-1.5 rounded-xl border border-slate-800 bg-slate-950/60 p-1">
                {vehicleFormSteps.map((step, index) => (
                  <button
                    key={step.id}
                    type="button"
                    onClick={() => setVehicleFormStep(step.id)}
                    className={`h-9 rounded-lg text-[11px] font-black transition-all ${
                      vehicleFormStep === step.id
                        ? 'bg-cyan-600 text-white shadow-lg shadow-cyan-600/20'
                        : 'text-slate-400'
                    }`}
                  >
                    <span className="mr-1 font-mono">{index + 1}</span>
                    {step.label}
                  </button>
                ))}
              </div>

              <div className="min-h-0 flex-1 py-3">
                {vehicleFormStep === 'CASE' && (
                  <div className="space-y-3">
                    <div>
                      <label className="mb-1.5 block text-[10px] font-bold uppercase tracking-[0.16em] text-slate-400">
                        {t('plateNumber')} *
                      </label>
                      <input
                        type="text"
                        value={plateInput}
                        onChange={(e) => setPlateInput(e.target.value)}
                        placeholder="ANN7569"
                        className="h-12 w-full rounded-xl border border-slate-800 bg-slate-950 px-3.5 font-mono text-lg font-black uppercase text-cyan-300 focus:outline-none focus:border-cyan-500"
                      />
                    </div>

                    <div className="grid grid-cols-2 gap-2.5">
                      <div>
                        <label className="mb-1.5 block text-[10px] font-bold uppercase tracking-[0.16em] text-slate-400">
                          {t('statusCase')}
                        </label>
                        <select
                          value={statusInput}
                          onChange={(e) => setStatusInput(e.target.value as VehicleStatus)}
                          className="h-11 w-full rounded-xl border border-slate-800 bg-slate-950 px-3 text-xs font-bold text-white focus:outline-none"
                        >
                          <option value="ACTIVE">{t('statusActive')}</option>
                          <option value="FLAGGED">{t('statusFlagged')}</option>
                          <option value="PENDING">{t('statusPending')}</option>
                          <option value="CLEARED">{t('statusCleared')}</option>
                        </select>
                      </div>

                      <div>
                        <label className="mb-1.5 block text-[10px] font-bold uppercase tracking-[0.16em] text-slate-400">
                          {t('priorityHeader')}
                        </label>
                        <select
                          value={priorityInput}
                          onChange={(e) => setPriorityInput(e.target.value as VehiclePriority)}
                          className="h-11 w-full rounded-xl border border-slate-800 bg-slate-950 px-3 text-xs font-bold text-white focus:outline-none"
                        >
                          <option value="HIGH">{t('priorityHigh')}</option>
                          <option value="MEDIUM">{t('priorityMedium')}</option>
                          <option value="LOW">{t('priorityLow')}</option>
                        </select>
                      </div>
                    </div>

                    <div>
                      <label className="mb-1.5 block text-[10px] font-bold uppercase tracking-[0.16em] text-slate-400">
                        Outstanding (RM)
                      </label>
                      <input
                        type="number"
                        value={outstandingInput}
                        onChange={(e) => setOutstandingInput(parseFloat(e.target.value) || 0)}
                        className="h-11 w-full rounded-xl border border-slate-800 bg-slate-950 px-3.5 font-mono text-sm font-black text-red-300 focus:outline-none"
                      />
                    </div>
                  </div>
                )}

                {vehicleFormStep === 'CUSTOMER' && (
                  <div className="space-y-3">
                    <div>
                      <label className="mb-1.5 block text-[10px] font-bold uppercase tracking-[0.16em] text-slate-400">
                        {t('customerName')} *
                      </label>
                      <input
                        type="text"
                        value={customerNameInput}
                        onChange={(e) => setCustomerNameInput(e.target.value)}
                        className="h-11 w-full rounded-xl border border-slate-800 bg-slate-950 px-3.5 text-sm font-bold text-white focus:outline-none focus:border-cyan-500"
                      />
                    </div>

                    <div>
                      <label className="mb-1.5 block text-[10px] font-bold uppercase tracking-[0.16em] text-slate-400">
                        {t('phoneHeader')}
                      </label>
                      <input
                        type="text"
                        value={phoneInput}
                        onChange={(e) => setPhoneInput(e.target.value)}
                        className="h-11 w-full rounded-xl border border-slate-800 bg-slate-950 px-3.5 font-mono text-sm text-white focus:outline-none"
                      />
                    </div>

                    <div>
                      <label className="mb-1.5 block text-[10px] font-bold uppercase tracking-[0.16em] text-slate-400">
                        {t('financeCompany')}
                      </label>
                      {selectedFinance === 'Other' ? (
                        <div className="relative">
                          <input
                            type="text"
                            value={customFinance}
                            onChange={(e) => setCustomFinance(e.target.value)}
                            placeholder="Masukkan nama bank/kewangan..."
                            className="h-11 w-full rounded-xl border border-cyan-500 bg-slate-950 pl-3.5 pr-8 text-xs font-bold text-cyan-300 focus:outline-none"
                            autoFocus
                          />
                          <button
                            type="button"
                            onClick={() => { setSelectedFinance('CIMB Bank'); setCustomFinance(''); }}
                            className="absolute right-2.5 top-1/2 -translate-y-1/2 p-0.5 text-xs font-bold text-slate-400 hover:text-cyan-400"
                            title="Tukar ke senarai"
                          >
                            ✕
                          </button>
                        </div>
                      ) : (
                        <select
                          value={selectedFinance}
                          onChange={(e) => setSelectedFinance(e.target.value)}
                          className="h-11 w-full rounded-xl border border-slate-800 bg-slate-950 px-3 text-xs font-bold text-white focus:outline-none"
                        >
                          {FINANCE_OPTIONS.map((f) => (
                            <option key={f} value={f}>
                              {f}
                            </option>
                          ))}
                        </select>
                      )}
                    </div>
                  </div>
                )}

                {vehicleFormStep === 'VEHICLE' && (
                  <div className="space-y-3">
                    <div className="grid grid-cols-2 gap-2.5">
                      <div>
                        <label className="mb-1.5 block text-[10px] font-bold uppercase tracking-[0.16em] text-slate-400">
                          Brand
                        </label>
                        {selectedBrand === 'Other' ? (
                          <div className="relative">
                            <input
                              type="text"
                              value={customBrand}
                              onChange={(e) => setCustomBrand(e.target.value)}
                              placeholder="Brand..."
                              className="h-11 w-full rounded-xl border border-cyan-500 bg-slate-950 pl-3 pr-7 text-xs font-bold text-cyan-300 focus:outline-none"
                              autoFocus
                            />
                            <button
                              type="button"
                              onClick={() => { setSelectedBrand('Perodua'); setCustomBrand(''); }}
                              className="absolute right-2 top-1/2 -translate-y-1/2 p-0.5 text-xs font-bold text-slate-400 hover:text-cyan-400"
                              title="Tukar ke senarai"
                            >
                              ✕
                            </button>
                          </div>
                        ) : (
                          <select
                            value={selectedBrand}
                            onChange={(e) => {
                              const val = e.target.value;
                              setSelectedBrand(val);
                              const defaultModels = MODEL_MAP[val];
                              setSelectedModel(defaultModels && defaultModels.length > 0 ? defaultModels[0] : 'Other');
                            }}
                            className="h-11 w-full rounded-xl border border-slate-800 bg-slate-950 px-3 text-xs font-bold text-white focus:outline-none"
                          >
                            {BRAND_OPTIONS.map((b) => (
                              <option key={b} value={b}>
                                {b}
                              </option>
                            ))}
                          </select>
                        )}
                      </div>

                      <div>
                        <label className="mb-1.5 block text-[10px] font-bold uppercase tracking-[0.16em] text-slate-400">
                          Model
                        </label>
                        {selectedModel === 'Other' || selectedBrand === 'Other' ? (
                          <div className="relative">
                            <input
                              type="text"
                              value={customModel}
                              onChange={(e) => setCustomModel(e.target.value)}
                              placeholder="Model..."
                              className="h-11 w-full rounded-xl border border-cyan-500 bg-slate-950 pl-3 pr-7 text-xs font-bold text-cyan-300 focus:outline-none"
                              autoFocus
                            />
                            {selectedBrand !== 'Other' && (
                              <button
                                type="button"
                                onClick={() => {
                                  const known = MODEL_MAP[selectedBrand];
                                  setSelectedModel(known && known.length > 0 ? known[0] : 'Myvi');
                                  setCustomModel('');
                                }}
                                className="absolute right-2 top-1/2 -translate-y-1/2 p-0.5 text-xs font-bold text-slate-400 hover:text-cyan-400"
                                title="Tukar ke senarai"
                              >
                                ✕
                              </button>
                            )}
                          </div>
                        ) : (
                          <select
                            value={selectedModel}
                            onChange={(e) => setSelectedModel(e.target.value)}
                            className="h-11 w-full rounded-xl border border-slate-800 bg-slate-950 px-3 text-xs font-bold text-white focus:outline-none"
                          >
                            {currentModelOptions.map((m) => (
                              <option key={m} value={m}>
                                {m}
                              </option>
                            ))}
                          </select>
                        )}
                      </div>
                    </div>

                    <div>
                      <label className="mb-1.5 block text-[10px] font-bold uppercase tracking-[0.16em] text-slate-400">
                        Warna
                      </label>
                      {selectedColour === 'Other' ? (
                        <div className="relative">
                          <input
                            type="text"
                            value={customColour}
                            onChange={(e) => setCustomColour(e.target.value)}
                            placeholder="Warna..."
                            className="h-11 w-full rounded-xl border border-cyan-500 bg-slate-950 pl-3.5 pr-8 text-xs font-bold text-cyan-300 focus:outline-none"
                            autoFocus
                          />
                          <button
                            type="button"
                            onClick={() => { setSelectedColour('White'); setCustomColour(''); }}
                            className="absolute right-2.5 top-1/2 -translate-y-1/2 p-0.5 text-xs font-bold text-slate-400 hover:text-cyan-400"
                            title="Tukar ke senarai"
                          >
                            ✕
                          </button>
                        </div>
                      ) : (
                        <select
                          value={selectedColour}
                          onChange={(e) => setSelectedColour(e.target.value)}
                          className="h-11 w-full rounded-xl border border-slate-800 bg-slate-950 px-3 text-xs font-bold text-white focus:outline-none"
                        >
                          {COLOUR_OPTIONS.map((c) => (
                            <option key={c} value={c}>
                              {c}
                            </option>
                          ))}
                        </select>
                      )}
                    </div>

                    <div>
                      <label className="mb-1.5 block text-[10px] font-bold uppercase tracking-[0.16em] text-slate-400">
                        {t('remarks')}
                      </label>
                      <textarea
                        value={remarkInput}
                        onChange={(e) => setRemarkInput(e.target.value)}
                        rows={2}
                        className="h-20 w-full resize-none rounded-xl border border-slate-800 bg-slate-950 p-3 text-xs text-white focus:outline-none focus:border-cyan-500"
                      />
                    </div>
                  </div>
                )}
              </div>

              <div className="grid shrink-0 grid-cols-2 gap-2 border-t border-slate-800 pt-3">
                <button
                  type="button"
                  onClick={isFirstVehicleFormStep ? () => setIsAddModalOpen(false) : goToPreviousVehicleFormStep}
                  className="h-11 rounded-xl bg-slate-800 text-xs font-bold text-slate-300 transition-all hover:bg-slate-700"
                >
                  {isFirstVehicleFormStep ? t('cancelBtn') : t('prevBtn')}
                </button>
                {isLastVehicleFormStep ? (
                  <button
                    type="submit"
                    disabled={!plateInput.trim() || !customerNameInput.trim()}
                    className="h-11 rounded-xl bg-cyan-600 text-xs font-black uppercase tracking-wider text-white shadow-lg shadow-cyan-600/20 transition-all hover:bg-cyan-500 disabled:opacity-40"
                  >
                    {t('saveBtn')}
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={goToNextVehicleFormStep}
                    disabled={!canContinueVehicleForm}
                    className="h-11 rounded-xl bg-cyan-600 text-xs font-black uppercase tracking-wider text-white shadow-lg shadow-cyan-600/20 transition-all hover:bg-cyan-500 disabled:opacity-40"
                  >
                    {t('nextBtn')}
                  </button>
                )}
              </div>
            </form>

            <form onSubmit={handleSaveForm} className="hidden sm:block space-y-3.5 pt-4">
              {/* Row 1: Nombor Plat & Status Kes */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
                <div>
                  <label className="block text-[11px] font-bold text-slate-300 uppercase tracking-wider mb-1.5">
                    {t('plateNumber')} *
                  </label>
                  <input
                    type="text"
                    value={plateInput}
                    onChange={(e) => setPlateInput(e.target.value)}
                    placeholder="ANN7569"
                    className="w-full h-10 bg-slate-950 border border-slate-800 rounded-xl px-3.5 text-xs font-mono font-bold uppercase text-cyan-400 focus:outline-none focus:border-cyan-500"
                    required
                  />
                </div>

                <div>
                  <label className="block text-[11px] font-bold text-slate-300 uppercase tracking-wider mb-1.5">
                    {t('statusCase')}
                  </label>
                  <select
                    value={statusInput}
                    onChange={(e) => setStatusInput(e.target.value as VehicleStatus)}
                    className="w-full h-10 bg-slate-950 border border-slate-800 rounded-xl px-3.5 text-xs text-white focus:outline-none cursor-pointer"
                  >
                    <option value="ACTIVE">{t('statusActive')}</option>
                    <option value="FLAGGED">{t('statusFlagged')}</option>
                    <option value="PENDING">{t('statusPending')}</option>
                    <option value="CLEARED">{t('statusCleared')}</option>
                  </select>
                </div>
              </div>

              {/* Row 2: Keutamaan & Syarikat Kewangan */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
                <div>
                  <label className="block text-[11px] font-bold text-slate-300 uppercase tracking-wider mb-1.5">
                    {t('priorityHeader')}
                  </label>
                  <select
                    value={priorityInput}
                    onChange={(e) => setPriorityInput(e.target.value as VehiclePriority)}
                    className="w-full h-10 bg-slate-950 border border-slate-800 rounded-xl px-3.5 text-xs text-white focus:outline-none cursor-pointer"
                  >
                    <option value="HIGH">{t('priorityHigh')}</option>
                    <option value="MEDIUM">{t('priorityMedium')}</option>
                    <option value="LOW">{t('priorityLow')}</option>
                  </select>
                </div>

                <div>
                  <label className="block text-[11px] font-bold text-slate-300 uppercase tracking-wider mb-1.5">
                    {t('financeCompany')}
                  </label>
                  {selectedFinance === 'Other' ? (
                    <div className="relative h-10 w-full">
                      <input
                        type="text"
                        value={customFinance}
                        onChange={(e) => setCustomFinance(e.target.value)}
                        placeholder="Masukkan nama bank/kewangan..."
                        className="w-full h-10 bg-slate-950 border border-cyan-500 rounded-xl pl-3.5 pr-8 text-xs text-cyan-300 focus:outline-none font-bold"
                        required
                        autoFocus
                      />
                      <button
                        type="button"
                        onClick={() => { setSelectedFinance('CIMB Bank'); setCustomFinance(''); }}
                        className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-cyan-400 p-0.5 text-xs font-bold"
                        title="Tukar ke senarai"
                      >
                        ✕
                      </button>
                    </div>
                  ) : (
                    <select
                      value={selectedFinance}
                      onChange={(e) => setSelectedFinance(e.target.value)}
                      className="w-full h-10 bg-slate-950 border border-slate-800 rounded-xl px-3.5 text-xs text-white focus:outline-none cursor-pointer"
                    >
                      {FINANCE_OPTIONS.map((f) => (
                        <option key={f} value={f}>
                          {f}
                        </option>
                      ))}
                    </select>
                  )}
                </div>
              </div>

              {/* Row 3: Nama Pelanggan & Nombor Telefon */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
                <div>
                  <label className="block text-[11px] font-bold text-slate-300 uppercase tracking-wider mb-1.5">
                    {t('customerName')} *
                  </label>
                  <input
                    type="text"
                    value={customerNameInput}
                    onChange={(e) => setCustomerNameInput(e.target.value)}
                    className="w-full h-10 bg-slate-950 border border-slate-800 rounded-xl px-3.5 text-xs text-white focus:outline-none"
                    required
                  />
                </div>

                <div>
                  <label className="block text-[11px] font-bold text-slate-300 uppercase tracking-wider mb-1.5">
                    {t('phoneHeader')}
                  </label>
                  <input
                    type="text"
                    value={phoneInput}
                    onChange={(e) => setPhoneInput(e.target.value)}
                    className="w-full h-10 bg-slate-950 border border-slate-800 rounded-xl px-3.5 text-xs font-mono text-white focus:outline-none"
                  />
                </div>
              </div>

              {/* Row 4: Brand & Model */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
                <div>
                  <label className="block text-[11px] font-bold text-slate-300 uppercase tracking-wider mb-1.5">Brand</label>
                  {selectedBrand === 'Other' ? (
                    <div className="relative h-10 w-full">
                      <input
                        type="text"
                        value={customBrand}
                        onChange={(e) => setCustomBrand(e.target.value)}
                        placeholder="Masukkan brand..."
                        className="w-full h-10 bg-slate-950 border border-cyan-500 rounded-xl pl-3.5 pr-8 text-xs text-cyan-300 focus:outline-none font-bold"
                        required
                        autoFocus
                      />
                      <button
                        type="button"
                        onClick={() => { setSelectedBrand('Perodua'); setCustomBrand(''); }}
                        className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-cyan-400 p-0.5 text-xs font-bold"
                        title="Tukar ke senarai"
                      >
                        ✕
                      </button>
                    </div>
                  ) : (
                    <select
                      value={selectedBrand}
                      onChange={(e) => {
                        const val = e.target.value;
                        setSelectedBrand(val);
                        const defaultModels = MODEL_MAP[val];
                        if (defaultModels && defaultModels.length > 0) {
                          setSelectedModel(defaultModels[0]);
                        } else {
                          setSelectedModel('Other');
                        }
                      }}
                      className="w-full h-10 bg-slate-950 border border-slate-800 rounded-xl px-3.5 text-xs text-white focus:outline-none cursor-pointer"
                    >
                      {BRAND_OPTIONS.map((b) => (
                        <option key={b} value={b}>
                          {b}
                        </option>
                      ))}
                    </select>
                  )}
                </div>

                <div>
                  <label className="block text-[11px] font-bold text-slate-300 uppercase tracking-wider mb-1.5">Model</label>
                  {selectedModel === 'Other' || selectedBrand === 'Other' ? (
                    <div className="relative h-10 w-full">
                      <input
                        type="text"
                        value={customModel}
                        onChange={(e) => setCustomModel(e.target.value)}
                        placeholder="Masukkan model..."
                        className="w-full h-10 bg-slate-950 border border-cyan-500 rounded-xl pl-3.5 pr-8 text-xs text-cyan-300 focus:outline-none font-bold"
                        required
                        autoFocus
                      />
                      {selectedBrand !== 'Other' && (
                        <button
                          type="button"
                          onClick={() => {
                            const known = MODEL_MAP[selectedBrand];
                            setSelectedModel(known && known.length > 0 ? known[0] : 'Myvi');
                            setCustomModel('');
                          }}
                          className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-cyan-400 p-0.5 text-xs font-bold"
                          title="Tukar ke senarai"
                        >
                          ✕
                        </button>
                      )}
                    </div>
                  ) : (
                    <select
                      value={selectedModel}
                      onChange={(e) => setSelectedModel(e.target.value)}
                      className="w-full h-10 bg-slate-950 border border-slate-800 rounded-xl px-3.5 text-xs text-white focus:outline-none cursor-pointer"
                    >
                      {currentModelOptions.map((m) => (
                        <option key={m} value={m}>
                          {m}
                        </option>
                      ))}
                    </select>
                  )}
                </div>
              </div>

              {/* Row 5: Warna & Tunggakan (RM) */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
                <div>
                  <label className="block text-[11px] font-bold text-slate-300 uppercase tracking-wider mb-1.5">Warna</label>
                  {selectedColour === 'Other' ? (
                    <div className="relative h-10 w-full">
                      <input
                        type="text"
                        value={customColour}
                        onChange={(e) => setCustomColour(e.target.value)}
                        placeholder="Masukkan warna..."
                        className="w-full h-10 bg-slate-950 border border-cyan-500 rounded-xl pl-3.5 pr-8 text-xs text-cyan-300 focus:outline-none font-bold"
                        required
                        autoFocus
                      />
                      <button
                        type="button"
                        onClick={() => { setSelectedColour('White'); setCustomColour(''); }}
                        className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-cyan-400 p-0.5 text-xs font-bold"
                        title="Tukar ke senarai"
                      >
                        ✕
                      </button>
                    </div>
                  ) : (
                    <select
                      value={selectedColour}
                      onChange={(e) => setSelectedColour(e.target.value)}
                      className="w-full h-10 bg-slate-950 border border-slate-800 rounded-xl px-3.5 text-xs text-white focus:outline-none cursor-pointer"
                    >
                      {COLOUR_OPTIONS.map((c) => (
                        <option key={c} value={c}>
                          {c}
                        </option>
                      ))}
                    </select>
                  )}
                </div>

                <div>
                  <label className="block text-[11px] font-bold text-slate-300 uppercase tracking-wider mb-1.5">
                    Outstanding (RM)
                  </label>
                  <input
                    type="number"
                    value={outstandingInput}
                    onChange={(e) => setOutstandingInput(parseFloat(e.target.value) || 0)}
                    className="w-full h-10 bg-slate-950 border border-slate-800 rounded-xl px-3.5 text-xs font-mono font-bold text-red-400 focus:outline-none"
                  />
                </div>
              </div>

              {/* Row 6: Nota Kes */}
              <div>
                <label className="block text-[11px] font-bold text-slate-300 uppercase tracking-wider mb-1.5">
                  {t('remarks')}
                </label>
                <textarea
                  value={remarkInput}
                  onChange={(e) => setRemarkInput(e.target.value)}
                  rows={2}
                  className="w-full bg-slate-950 border border-slate-800 rounded-xl p-3 text-xs text-white focus:outline-none focus:border-cyan-500"
                />
              </div>

              <div className="grid grid-cols-2 gap-2 pt-3 border-t border-slate-800 sm:flex sm:items-center sm:justify-end">
                <button
                  type="button"
                  onClick={() => setIsAddModalOpen(false)}
                  className="px-4 py-2 rounded-xl bg-slate-800 text-slate-300 text-xs font-bold hover:bg-slate-700 transition-all"
                >
                  {t('cancelBtn')}
                </button>
                <button
                  type="submit"
                  className="px-5 py-2 rounded-xl bg-cyan-600 hover:bg-cyan-500 text-white font-black text-xs uppercase tracking-wider transition-all shadow-lg shadow-cyan-600/20"
                >
                  {t('saveBtn')}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* DELETE CONFIRMATION MODAL */}
      {deletingVehicleId && (
        <div className="fixed inset-0 z-50 bg-slate-950/80 backdrop-blur-md flex items-center justify-center p-3 sm:p-4">
          <div className="bg-slate-900 border border-red-900/60 rounded-2xl p-4 sm:p-6 w-full max-w-md shadow-2xl space-y-4 text-center max-h-[calc(100dvh-1.5rem)] overflow-y-auto">
            <Trash2 className="w-10 h-10 text-red-400 mx-auto" />
            <h2 className="text-lg font-bold text-white">{t('deleteVehicle')}</h2>
            <p className="text-xs text-slate-300">{t('confirmDelete')}</p>
            <div className="flex items-center justify-center gap-3 pt-2">
              <button
                onClick={() => setDeletingVehicleId(null)}
                className="px-4 py-2 rounded-xl bg-slate-800 text-slate-300 text-xs font-bold"
              >
                {t('cancelBtn')}
              </button>
              <button
                onClick={handleDeleteConfirm}
                className="px-4 py-2 rounded-xl bg-red-600 hover:bg-red-500 text-white font-bold text-xs uppercase"
              >
                {t('deleteNowBtn')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* IMPORT CSV MODAL */}
      {isImportModalOpen && (
        <div className="fixed inset-0 z-50 bg-slate-950/80 backdrop-blur-md flex items-center justify-center p-3 sm:p-4">
          <div className="bg-slate-900 border border-cyan-900/50 rounded-2xl p-4 sm:p-6 w-full max-w-lg shadow-2xl space-y-4 max-h-[calc(100dvh-1.5rem)] overflow-y-auto">
            <div className="flex items-center justify-between border-b border-slate-800 pb-3">
              <h2 className="text-lg font-bold text-white flex items-center gap-2">
                <FileSpreadsheet className="w-5 h-5 text-cyan-400" />
                <span>Import Vehicles CSV</span>
              </h2>
              <button
                onClick={() => setIsImportModalOpen(false)}
                className="p-1 rounded-lg hover:bg-slate-800 text-slate-400"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* Template Download Box */}
            <div className="p-3 rounded-xl bg-cyan-950/40 border border-cyan-800/60 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
              <div className="flex items-center gap-2 text-xs">
                <FileText className="w-4 h-4 text-cyan-400 shrink-0" />
                <div>
                  <div className="font-bold text-cyan-300">Need standard CSV format?</div>
                  <div className="text-[11px] text-slate-400">Download formatted CSV template file to fill in.</div>
                </div>
              </div>
              <button
                onClick={downloadCSVTemplate}
                type="button"
                className="w-full sm:w-auto px-3 py-2 sm:py-1.5 rounded-lg bg-cyan-500 hover:bg-cyan-400 text-slate-950 font-bold text-xs shrink-0 flex items-center justify-center gap-1 transition-all"
              >
                <Download className="w-3.5 h-3.5" />
                <span>Download Template</span>
              </button>
            </div>

            <form onSubmit={handleCsvImportSubmit} className="space-y-4">
              <p className="text-xs text-slate-400">
                Paste your CSV content below or fill out the downloaded template file:
              </p>

              <textarea
                value={csvText}
                onChange={(e) => setCsvText(e.target.value)}
                placeholder={`Plate,Customer,Customer_ID,Phone,Brand,Model,Colour,Year,Finance,Outstanding,Reference,Priority,Status,Remark\nANN7569,Ahmad,CUST-001,+60123456789,Perodua,Bezza,White,2021,CIMB,15000,CIMB001,HIGH,ACTIVE,Repo`}
                rows={6}
                className="w-full bg-slate-950 border border-slate-800 rounded-xl p-3 text-xs font-mono text-cyan-300 focus:outline-none"
              />

              <div className="grid grid-cols-2 gap-2 pt-2 border-t border-slate-800 sm:flex sm:items-center sm:justify-end">
                <button
                  type="button"
                  onClick={() => setIsImportModalOpen(false)}
                  className="px-4 py-2 rounded-xl bg-slate-800 text-slate-300 text-xs font-bold"
                >
                  {t('cancelBtn')}
                </button>
                <button
                  type="submit"
                  className="px-5 py-2 rounded-xl bg-cyan-600 hover:bg-cyan-500 text-white font-black text-xs uppercase tracking-wider transition-all"
                >
                  Parse & Import CSV
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
