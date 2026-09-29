'use client';

import React, { Fragment, useEffect, useState } from 'react';
import { useStorage } from '@/context/StorageContext';
import { useLanguage } from '@/context/LanguageContext';
import { useAuth } from '@/context/AuthContext';
import { cleanPlateNumber, formatMYR, formatDate } from '@/lib/utils';
import { Vehicle } from '@/types';
import {
  Search as SearchIcon,
  ShieldAlert,
  CheckCircle2,
  AlertTriangle,
  XCircle,
  Copy,
  Check,
  Building2,
  User,
  Car,
  FileText,
  DollarSign,
  Tag,
  BookmarkCheck,
  Clock,
  History,
  X,
} from 'lucide-react';

export default function SearchPage() {
  const { searchVehicles, addHistoryLog, updateVehicle, history } = useStorage();
  const { t, language } = useLanguage();
  const { role } = useAuth();

  const [inputQuery, setInputQuery] = useState('');
  const [exactResult, setExactResult] = useState<Vehicle | null>(null);
  const [possibleResults, setPossibleResults] = useState<Vehicle[]>([]);
  const [hasSearched, setHasSearched] = useState(false);
  const [copiedPlate, setCopiedPlate] = useState(false);
  const [copiedCase, setCopiedCase] = useState(false);
  const [actionMarked, setActionMarked] = useState(false);
  const [customActionNote, setCustomActionNote] = useState('');
  const [expandedHistoryId, setExpandedHistoryId] = useState<string | null>(null);
  const searchHistory = history.filter((log) => log.type === 'SEARCH').slice(0, 6);
  const getSearchPlate = (log: (typeof searchHistory)[number]) =>
    log.plate || log.action.match(/(?:Manual Search|Manual Search Plate):\s*([A-Z0-9]+)/i)?.[1] || '-';
  const toggleHistoryDetails = (id: string) => {
    setExpandedHistoryId((current) => (current === id ? null : id));
  };

  // Auto clean plate input as user types
  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setInputQuery(cleanPlateNumber(e.target.value));
  };

  const executeSearch = (query: string) => {
    const cleanedQuery = cleanPlateNumber(query);
    if (!cleanedQuery.trim()) return;

    setInputQuery(cleanedQuery);

    const { exactMatch, possibleMatches } = searchVehicles(cleanedQuery);
    
    // Automatically update vehicle status to FLAGGED in Vehicle Management when matched
    if (exactMatch) {
      const flaggedObj = { ...exactMatch, status: 'FLAGGED' as const };
      updateVehicle(flaggedObj);
      setExactResult(flaggedObj);
    } else {
      setExactResult(null);
    }

    setPossibleResults(possibleMatches);
    setHasSearched(true);
    setActionMarked(false);

    // Trigger history log if exact match found
    if (exactMatch) {
      addHistoryLog({
        type: 'SEARCH',
        action: `Tanda Tindakan (Carian): ${exactMatch.plate}`,
        plate: exactMatch.plate,
        details: `Tanda Tindakan - Padanan Kes: ${exactMatch.brand} ${exactMatch.model} (${exactMatch.financeCompany} ${formatMYR(exactMatch.outstandingAmount)})`,
        note: `Match Found: ${exactMatch.brand} ${exactMatch.model} (${exactMatch.financeCompany})`,
        userRole: role,
        statusMatch: 'EXACT',
      });
    } else if (possibleMatches.length > 0) {
      addHistoryLog({
        type: 'SEARCH',
        action: `Manual Search: ${cleanedQuery}`,
        plate: cleanedQuery,
        details: `Possible Matches Found (${possibleMatches.length})`,
        userRole: role,
        statusMatch: 'POSSIBLE',
      });
    } else {
      addHistoryLog({
        type: 'SEARCH',
        action: `Manual Search: ${cleanedQuery}`,
        plate: cleanedQuery,
        details: `No Match Found`,
        userRole: role,
        statusMatch: 'NONE',
      });
    }
  };

  useEffect(() => {
    const timer = window.setTimeout(() => {
      const plateParam = cleanPlateNumber(new URLSearchParams(window.location.search).get('plate') || '');
      if (plateParam) executeSearch(plateParam);
    }, 50);

    return () => window.clearTimeout(timer);
  }, []);

  const handleSearch = (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    executeSearch(inputQuery);
  };

  const handleMarkAction = () => {
    setActionMarked(true);
    if (exactResult) {
      const flaggedObj = { ...exactResult, status: 'FLAGGED' as const };
      updateVehicle(flaggedObj);
      setExactResult(flaggedObj);
      const actionNote = customActionNote.trim() || `Ditanda untuk tindakan Unit Tunda oleh ${role}`;
      addHistoryLog({
        type: 'SEARCH',
        action: `Tanda Tindakan (Unit Tunda): ${exactResult.plate}`,
        plate: exactResult.plate,
        details: actionNote,
        note: actionNote,
        userRole: role,
        statusMatch: 'EXACT',
      });
    }
  };

  const handleMarkPending = () => {
    setActionMarked(true);
    if (exactResult) {
      const pendingObj = { ...exactResult, status: 'PENDING' as const };
      updateVehicle(pendingObj);
      setExactResult(pendingObj);
      const actionNote = customActionNote.trim() || `Ditanda Dalam Semakan oleh ${role}`;
      addHistoryLog({
        type: 'SEARCH',
        action: `Dalam Semakan: ${exactResult.plate}`,
        plate: exactResult.plate,
        details: actionNote,
        note: actionNote,
        userRole: role,
        statusMatch: 'POSSIBLE',
      });
    }
  };

  const handleMarkCleared = () => {
    setActionMarked(true);
    if (exactResult) {
      const clearedObj = { ...exactResult, status: 'CLEARED' as const };
      updateVehicle(clearedObj);
      setExactResult(clearedObj);
      const actionNote = customActionNote.trim() || `Kes Diselesaikan oleh ${role}`;
      addHistoryLog({
        type: 'SEARCH',
        action: `Kes Selesai: ${exactResult.plate}`,
        plate: exactResult.plate,
        details: actionNote,
        note: actionNote,
        userRole: role,
        statusMatch: 'NONE',
      });
    }
  };

  return (
    <div className="max-w-4xl mx-auto space-y-2.5 sm:space-y-6">
      {/* Header */}
      <div className="space-y-0.5 sm:space-y-1">
        <h1 className="text-base sm:text-2xl font-black text-white tracking-wide">
          {t('searchTitle')}
        </h1>
      </div>

      {/* Search Bar Container */}
      <form
        onSubmit={handleSearch}
        className="bg-slate-900/90 border border-cyan-900/50 rounded-xl sm:rounded-2xl p-2.5 sm:p-4 shadow-xl backdrop-blur-md"
      >
        {/* Input + Button */}
        <div className="flex items-center gap-2">
          <div className="relative flex-1 min-w-0">
            <input
              type="text"
              value={inputQuery}
              onChange={handleInputChange}
              placeholder={t('searchPlaceholder')}
              className="w-full bg-slate-950 border-2 border-cyan-500/40 rounded-lg sm:rounded-xl px-3 py-1.5 sm:py-3 text-sm sm:text-xl font-mono font-black uppercase text-cyan-300 placeholder:text-slate-600 focus:outline-none focus:border-cyan-400 focus:ring-2 focus:ring-cyan-500/20 transition-all tracking-wider"
              autoFocus
            />
            {inputQuery && (
              <span className="hidden sm:inline-block absolute right-3 top-3.5 text-[9px] font-mono font-bold uppercase tracking-wider text-slate-500 bg-slate-900 px-2 py-0.5 rounded border border-slate-800 pointer-events-none">
                AUTO-FORMATTED
              </span>
            )}
          </div>
          <button
            type="submit"
            className="px-3.5 sm:px-6 py-2 sm:py-3.5 rounded-lg sm:rounded-xl bg-cyan-600 hover:bg-cyan-500 text-white font-black text-xs sm:text-sm uppercase tracking-wider shadow-lg shadow-cyan-500/20 transition-all shrink-0 flex items-center justify-center gap-1.5 sm:gap-2"
          >
            <SearchIcon className="w-3.5 h-3.5 sm:w-5 sm:h-5" />
            <span>{t('searchBtn')}</span>
          </button>
        </div>
      </form>

      <div className="bg-slate-900/90 border border-slate-800 rounded-xl sm:rounded-2xl p-3 sm:p-4 shadow-xl space-y-3">
        <div className="flex items-center justify-between border-b border-slate-800 pb-2.5">
          <div className="flex items-center gap-2">
            <History className="w-4 h-4 text-cyan-400" />
            <h2 className="text-xs sm:text-sm font-bold text-white uppercase tracking-wider">
              Search History
            </h2>
          </div>
          <span className="text-[10px] font-mono text-slate-500">
            {searchHistory.length} recent
          </span>
        </div>

        <div className="sm:hidden space-y-2">
          {searchHistory.length > 0 ? (
            searchHistory.map((log) => (
              <button
                key={log.id}
                type="button"
                onClick={() => toggleHistoryDetails(log.id)}
                className="w-full text-left p-2.5 rounded-xl bg-slate-950/80 border border-slate-800 space-y-1.5 hover:border-cyan-900/70 transition-all"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="font-mono font-black text-cyan-300 text-xs">{getSearchPlate(log)}</span>
                  <span
                    className={`px-2 py-0.5 rounded-md border text-[9px] font-bold uppercase ${
                      log.statusMatch === 'EXACT'
                        ? 'bg-red-950/70 text-red-300 border-red-800'
                        : log.statusMatch === 'POSSIBLE'
                        ? 'bg-amber-950/70 text-amber-300 border-amber-800'
                        : 'bg-slate-950 text-slate-400 border-slate-700'
                    }`}
                  >
                    {log.statusMatch === 'EXACT' ? 'Found' : log.statusMatch === 'POSSIBLE' ? 'Possible' : 'No Match'}
                  </span>
                </div>
                <p className="text-[11px] text-slate-300 truncate">{log.note || log.details}</p>
                <div className="text-[10px] text-slate-500 font-mono">{formatDate(log.timestamp)}</div>
                {expandedHistoryId === log.id && (
                  <div className="mt-2 pt-2 border-t border-slate-800 grid grid-cols-1 gap-1 text-[10px] text-slate-400">
                    <div><span className="text-slate-500">Action:</span> {log.action}</div>
                    <div><span className="text-slate-500">Details:</span> {log.details}</div>
                    {log.note && <div><span className="text-slate-500">Note:</span> {log.note}</div>}
                    <div><span className="text-slate-500">Last Dijumpai:</span> {formatDate(log.timestamp)}</div>
                  </div>
                )}
              </button>
            ))
          ) : (
            <div className="py-5 text-center text-xs text-slate-500">No manual searches yet.</div>
          )}
        </div>

        <div className="hidden sm:block overflow-x-auto">
          <table className="w-full text-left text-xs min-w-[560px]">
            <thead className="bg-slate-950 text-slate-400 uppercase font-mono text-[10px] border-b border-slate-800 whitespace-nowrap">
              <tr>
                <th className="py-2.5 px-3">{t('plateNumber')}</th>
                <th className="py-2.5 px-3">{t('matchDetails')}</th>
                <th className="py-2.5 px-3 text-center">Result</th>
                <th className="py-2.5 px-3 text-right">{t('timestamp')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/60">
              {searchHistory.length > 0 ? (
                searchHistory.map((log) => (
                  <Fragment key={log.id}>
                    <tr
                      onClick={() => toggleHistoryDetails(log.id)}
                      className="hover:bg-slate-800/40 transition-colors cursor-pointer"
                    >
                      <td className="py-2.5 px-3 font-mono font-black text-cyan-300">{getSearchPlate(log)}</td>
                      <td className="py-2.5 px-3 text-slate-300 font-medium truncate max-w-[320px]">
                        {log.note || log.details}
                      </td>
                      <td className="py-2.5 px-3 text-center">
                        <span
                          className={`inline-flex items-center justify-center w-24 h-6 rounded-md border text-[9px] font-bold uppercase ${
                            log.statusMatch === 'EXACT'
                              ? 'bg-red-950/70 text-red-300 border-red-800'
                              : log.statusMatch === 'POSSIBLE'
                              ? 'bg-amber-950/70 text-amber-300 border-amber-800'
                              : 'bg-slate-950 text-slate-400 border-slate-700'
                          }`}
                        >
                          {log.statusMatch === 'EXACT' ? 'Found' : log.statusMatch === 'POSSIBLE' ? 'Possible' : 'No Match'}
                        </span>
                      </td>
                      <td className="py-2.5 px-3 text-right text-slate-500 font-mono text-[11px]">
                        {formatDate(log.timestamp)}
                      </td>
                    </tr>
                    {expandedHistoryId === log.id && (
                      <tr className="bg-slate-950/70">
                        <td colSpan={4} className="px-3 py-3">
                          <div className="grid grid-cols-1 md:grid-cols-2 gap-2 text-[11px] text-slate-400">
                            <div><span className="text-slate-500">Action:</span> {log.action}</div>
                            <div><span className="text-slate-500">Last Dijumpai:</span> {formatDate(log.timestamp)}</div>
                            <div className="md:col-span-2"><span className="text-slate-500">Details:</span> {log.details}</div>
                            {log.note && <div className="md:col-span-2"><span className="text-slate-500">Note:</span> {log.note}</div>}
                          </div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))
              ) : (
                <tr>
                  <td colSpan={4} className="py-6 text-center text-slate-500">
                    No manual searches yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Results Section */}
      {hasSearched && (
        <div className="space-y-3 sm:space-y-6">
          {/* 1. EXACT MATCH CRITICAL ALERT CARD */}
          {exactResult ? (
            <div className="fixed inset-0 z-50 bg-slate-950/80 backdrop-blur-md p-3 sm:p-6 flex items-center justify-center">
            <div className="w-full max-w-5xl max-h-[92vh] overflow-y-auto bg-slate-900 border-2 border-red-500 rounded-xl sm:rounded-2xl p-3 sm:p-6 shadow-2xl glow-danger space-y-2.5 sm:space-y-5">
              {/* Alert Header */}
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-red-900/50 pb-2 sm:pb-4">
                <div className="flex items-center gap-2 sm:gap-3">
                  <div className="w-8 h-8 sm:w-12 sm:h-12 rounded-lg sm:rounded-xl bg-red-950 border border-red-500/60 flex items-center justify-center text-red-400 animate-pulse shrink-0">
                    <ShieldAlert className="w-5 h-5 sm:w-7 sm:h-7" />
                  </div>
                  <div>
                    <div className="text-[9px] sm:text-[10px] font-black text-red-400 uppercase tracking-widest">
                      {t('criticalAlert')}
                    </div>
                    <h2 className="text-sm sm:text-2xl font-black text-white tracking-wide">
                      {t('matchFound')}
                    </h2>
                  </div>
                </div>

                <div className="flex items-center gap-1.5 sm:gap-2">
                  <span className="text-[9px] sm:text-xs font-black uppercase px-2 py-0.5 sm:px-3 sm:py-1 rounded-full bg-red-950 text-red-400 border border-red-500/60 animate-pulse">
                    {exactResult.status}
                  </span>
                  <span className="text-[9px] sm:text-xs font-black uppercase px-2 py-0.5 sm:px-3 sm:py-1 rounded-full bg-amber-950 text-amber-400 border border-amber-500/60">
                    PRIORITY: {exactResult.priority}
                  </span>
                  <button
                    type="button"
                    onClick={() => {
                      setExactResult(null);
                      setHasSearched(false);
                    }}
                    className="p-1.5 rounded-lg bg-slate-950 border border-slate-700 text-slate-400 hover:text-white hover:border-slate-500 transition-all"
                    title={t('closeBtn')}
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>
              </div>

              {/* Vehicle Dossier Grid - 2 columns on mobile, 3 on desktop */}
              <div className="grid grid-cols-2 lg:grid-cols-3 gap-2 sm:gap-4">
                {/* Plate */}
                <div className="p-2 sm:p-3.5 rounded-lg sm:rounded-xl bg-slate-950 border border-slate-800 space-y-0.5">
                  <div className="text-[9px] sm:text-[10px] font-bold text-slate-400 uppercase flex items-center gap-1">
                    <Tag className="w-3 h-3 text-cyan-400" />
                    <span>{t('plateNumber')}</span>
                  </div>
                  <div className="text-base sm:text-2xl font-black font-mono text-cyan-400">
                    {exactResult.plate}
                  </div>
                </div>

                {/* Outstanding Amount */}
                <div className="p-2 sm:p-3.5 rounded-lg sm:rounded-xl bg-slate-950 border border-red-900/50 space-y-0.5">
                  <div className="text-[9px] sm:text-[10px] font-bold text-slate-400 uppercase flex items-center gap-1">
                    <DollarSign className="w-3 h-3 text-red-400" />
                    <span>{t('outstandingAmount')}</span>
                  </div>
                  <div className="text-base sm:text-xl font-black text-red-400 font-mono">
                    {formatMYR(exactResult.outstandingAmount)}
                  </div>
                </div>

                {/* Customer */}
                <div className="p-2 sm:p-3.5 rounded-lg sm:rounded-xl bg-slate-950 border border-slate-800 space-y-0.5">
                  <div className="text-[9px] sm:text-[10px] font-bold text-slate-400 uppercase flex items-center gap-1">
                    <User className="w-3 h-3 text-blue-400" />
                    <span>{t('customerName')}</span>
                  </div>
                  <div className="text-xs sm:text-base font-bold text-white truncate">
                    {exactResult.customerName}
                  </div>
                  <div className="text-[9px] sm:text-[11px] text-slate-400 font-mono truncate">
                    {exactResult.phone}
                  </div>
                </div>

                {/* Vehicle Model & Color */}
                <div className="p-2 sm:p-3.5 rounded-lg sm:rounded-xl bg-slate-950 border border-slate-800 space-y-0.5">
                  <div className="text-[9px] sm:text-[10px] font-bold text-slate-400 uppercase flex items-center gap-1">
                    <Car className="w-3 h-3 text-purple-400" />
                    <span>{t('vehicleDetails')}</span>
                  </div>
                  <div className="text-xs sm:text-base font-bold text-white truncate">
                    {exactResult.brand} {exactResult.model}
                  </div>
                  <div className="text-[9px] sm:text-[11px] text-slate-400 truncate">
                    {exactResult.colour} ({exactResult.year})
                  </div>
                </div>

                {/* Finance Company */}
                <div className="p-2 sm:p-3.5 rounded-lg sm:rounded-xl bg-slate-950 border border-slate-800 space-y-0.5">
                  <div className="text-[9px] sm:text-[10px] font-bold text-slate-400 uppercase flex items-center gap-1">
                    <Building2 className="w-3 h-3 text-emerald-400" />
                    <span>{t('financeCompany')}</span>
                  </div>
                  <div className="text-xs sm:text-base font-bold text-white truncate">
                    {exactResult.financeCompany}
                  </div>
                  <div className="text-[9px] sm:text-[11px] text-slate-400 font-mono truncate">
                    Ref: {exactResult.reference}
                  </div>
                </div>

                {/* Case Reference */}
                <div className="p-2 sm:p-3.5 rounded-lg sm:rounded-xl bg-slate-950 border border-slate-800 space-y-0.5">
                  <div className="text-[9px] sm:text-[10px] font-bold text-slate-400 uppercase flex items-center gap-1">
                    <FileText className="w-3 h-3 text-amber-400" />
                    <span>{t('caseReference')}</span>
                  </div>
                  <div className="text-xs sm:text-base font-bold font-mono text-slate-200 truncate">
                    {exactResult.reference}
                  </div>
                </div>
              </div>

              {/* Remarks */}
              <div className="p-2 sm:p-3.5 rounded-lg sm:rounded-xl bg-slate-950 border border-slate-800">
                <div className="text-[9px] sm:text-[10px] font-bold text-slate-400 uppercase mb-0.5">
                  {t('remarks')}
                </div>
                <p className="text-[11px] sm:text-xs text-slate-300 italic truncate">{exactResult.remark}</p>
              </div>

              {/* Optional Nota Tindakan Field */}
              <div className="p-2.5 sm:p-3.5 rounded-lg sm:rounded-xl bg-slate-950 border border-cyan-900/50 space-y-1">
                <label className="block text-[11px] sm:text-xs font-bold text-cyan-400">
                  {t('notaTindakanCol')} ({language === 'BM' ? 'Pilihan' : 'Optional'})
                </label>
                <input
                  type="text"
                  value={customActionNote}
                  onChange={(e) => setCustomActionNote(e.target.value)}
                  placeholder={t('notaTindakanPlaceholder')}
                  className="w-full bg-slate-900 border border-slate-800 rounded-lg px-2.5 py-1.5 text-xs text-white placeholder:text-slate-500 focus:outline-none focus:border-cyan-500 transition-all font-sans"
                />
              </div>

              {/* Action Buttons - Role-based permissions */}
              <div className="pt-1.5 sm:pt-2 border-t border-slate-800 flex flex-wrap items-center gap-2">
                <button
                  onClick={handleMarkAction}
                  className={`flex-1 sm:flex-initial px-4 py-2 sm:py-2.5 rounded-lg sm:rounded-xl text-xs font-bold border flex items-center justify-center gap-2 transition-all ${
                    exactResult.status === 'FLAGGED'
                      ? 'bg-red-950 border-red-500 text-red-300 shadow-sm'
                      : 'bg-red-950/60 hover:bg-red-900 border-red-800 text-red-200'
                  }`}
                >
                  <BookmarkCheck className="w-4 h-4 text-red-400" />
                  <span>{t('markAction')}</span>
                </button>

                {(role === 'ADMIN' || role === 'SUPER_ADMIN') && (
                  <>
                    <button
                      onClick={handleMarkPending}
                      className={`flex-1 sm:flex-initial px-4 py-2 sm:py-2.5 rounded-lg sm:rounded-xl text-xs font-bold border flex items-center justify-center gap-2 transition-all ${
                        exactResult.status === 'PENDING'
                          ? 'bg-amber-950 border-amber-500 text-amber-300 shadow-sm'
                          : 'bg-amber-950/60 hover:bg-amber-900 border-amber-800 text-amber-200'
                      }`}
                    >
                      <Clock className="w-4 h-4 text-amber-400" />
                      <span>{t('statusPending')}</span>
                    </button>

                    <button
                      onClick={handleMarkCleared}
                      className={`flex-1 sm:flex-initial px-4 py-2 sm:py-2.5 rounded-lg sm:rounded-xl text-xs font-bold border flex items-center justify-center gap-2 transition-all ${
                        exactResult.status === 'CLEARED'
                          ? 'bg-emerald-950 border-emerald-500 text-emerald-300 shadow-sm'
                          : 'bg-emerald-950/60 hover:bg-emerald-900 border-emerald-800 text-emerald-200'
                      }`}
                    >
                      <CheckCircle2 className="w-4 h-4 text-emerald-400" />
                      <span>{t('statusCleared')}</span>
                    </button>
                  </>
                )}
              </div>
            </div>
            </div>
          ) : possibleResults.length > 0 ? (
            /* 2. POSSIBLE MATCH CARD */
            <div className="bg-slate-900/90 border-2 border-amber-500 rounded-2xl p-6 shadow-xl space-y-4">
              <div className="flex items-center gap-3">
                <AlertTriangle className="w-7 h-7 text-amber-400" />
                <div>
                  <h2 className="text-xl font-bold text-white">{t('possibleMatchFound')}</h2>
                  <p className="text-xs text-amber-400">
                    Found {possibleResults.length} vehicle(s) matching partial search query.
                  </p>
                </div>
              </div>

              <div className="space-y-3">
                {possibleResults.map((v) => (
                  <div
                    key={v.id}
                    className="p-4 rounded-xl bg-slate-950 border border-slate-800 flex flex-col sm:flex-row sm:items-center justify-between gap-3"
                  >
                    <div>
                      <span className="font-mono font-black text-cyan-400 text-lg mr-3">
                        {v.plate}
                      </span>
                      <span className="text-xs text-slate-300 font-bold">
                        {v.customerName} ({v.brand} {v.model})
                      </span>
                      <div className="text-[11px] text-slate-400">
                        Finance: {v.financeCompany} | {formatMYR(v.outstandingAmount)}
                      </div>
                    </div>
                    <button
                      onClick={() => setExactResult(v)}
                      className="px-3 py-1.5 rounded-lg bg-cyan-950 text-cyan-400 border border-cyan-800 text-xs font-bold hover:bg-cyan-900 transition-colors shrink-0"
                    >
                      {t('openDetails')}
                    </button>
                  </div>
                ))}
              </div>
            </div>
          ) : (
            /* 3. NO MATCH CARD */
            <div className="bg-slate-900/90 border border-slate-800 rounded-2xl p-10 shadow-xl text-center space-y-3">
              <div className="w-14 h-14 rounded-2xl bg-slate-950 border border-slate-800 flex items-center justify-center mx-auto text-slate-500">
                <XCircle className="w-8 h-8" />
              </div>
              <h2 className="text-lg font-bold text-white">{t('noMatchTitle')}</h2>
              <p className="text-xs text-slate-400 max-w-sm mx-auto">{t('noMatchDesc')}</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
