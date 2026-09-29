'use client';

import React, { useState } from 'react';
import { useStorage } from '@/context/StorageContext';
import { useLanguage } from '@/context/LanguageContext';
import { downloadCSV, formatDate } from '@/lib/utils';
import {
  History,
  Download,
  Search,
  Camera,
  Car,
  Users,
  Filter,
  ChevronLeft,
  ChevronRight,
  SlidersHorizontal,
  ArrowUpDown,
  Calendar,
} from 'lucide-react';
import { useAuth } from '@/context/AuthContext';

export default function HistoryPage() {
  const { history, users } = useStorage();
  const { t, language } = useLanguage();
  const { currentUser, role } = useAuth();

  const showRoleColumn = role === 'SUPER_ADMIN';
  const adminUserIds = users.filter((user) => user.createdBy === currentUser?.id).map((user) => user.id);
  const visibleAuditLogs = history.filter((log) => {
    const searchOrDetectionOnly = log.type === 'SEARCH' || log.type === 'DETECTION';
    if (role === 'USER' && !searchOrDetectionOnly) return false;
    if (role === 'SUPER_ADMIN') return true;
    if (log.actorId) {
      return role === 'ADMIN'
        ? log.actorId === currentUser?.id || adminUserIds.includes(log.actorId)
        : log.actorId === currentUser?.id;
    }
    if (role === 'ADMIN') return log.userRole === 'ADMIN' || log.userRole === 'USER';
    return log.userRole === 'USER';
  });

  // Filter States
  const [showFilterDrawer, setShowFilterDrawer] = useState(false);
  const [filterType, setFilterType] = useState<'ALL' | 'SEARCH' | 'DETECTION' | 'VEHICLE' | 'USER'>('ALL');
  const [statusMatchFilter, setStatusMatchFilter] = useState<'ALL' | 'EXACT' | 'POSSIBLE' | 'NONE'>('ALL');
  const [sortOrder, setSortOrder] = useState<'NEWEST' | 'OLDEST' | 'PLATE_AZ'>('NEWEST');
  const [searchQuery, setSearchQuery] = useState('');

  // Pagination State
  const [currentPage, setCurrentPage] = useState<number>(1);
  const [pageSize, setPageSize] = useState<number>(10);

  // Filtering & Sorting Logic
  let filteredLogs = visibleAuditLogs.filter((h) => {
    const matchesType = filterType === 'ALL' || h.type === filterType;
    const matchesStatus = statusMatchFilter === 'ALL' || h.statusMatch === statusMatchFilter;

    const q = searchQuery.toLowerCase();
    const p = (h.plate || '').toLowerCase();
    const act = h.action.toLowerCase();
    const det = h.details.toLowerCase();

    const matchesSearch = !searchQuery || p.includes(q) || act.includes(q) || det.includes(q);
    return matchesType && matchesStatus && matchesSearch;
  });

  // Apply Sorting
  filteredLogs = [...filteredLogs].sort((a, b) => {
    if (sortOrder === 'NEWEST') {
      return new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime();
    } else if (sortOrder === 'OLDEST') {
      return new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime();
    } else if (sortOrder === 'PLATE_AZ') {
      return (a.plate || '').localeCompare(b.plate || '');
    }
    return 0;
  });

  // Pagination Math
  const totalItems = filteredLogs.length;
  const totalPages = Math.ceil(totalItems / pageSize) || 1;
  const safeCurrentPage = Math.min(currentPage, totalPages);
  const startIndex = (safeCurrentPage - 1) * pageSize;
  const paginatedLogs = filteredLogs.slice(startIndex, startIndex + pageSize);
  const handleExportVisibleHistory = () => {
    const headers = 'ID,Type,Action,Plate,Details,Actor,Timestamp,MatchStatus\n';
    const rows = filteredLogs
      .map(
        (h) =>
          `"${h.id}","${h.type}","${h.action}","${h.plate || ''}","${h.details}","${h.actorName || h.userRole}","${formatDate(
            h.timestamp
          )}","${h.statusMatch || ''}"`
      )
      .join('\n');
    downloadCSV(`track_audit_history_${role.toLowerCase()}_${Date.now()}.csv`, headers + rows);
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 sm:gap-4">
        <div>
          <h1 className="text-xl sm:text-2xl font-black text-white tracking-wide">
            {t('historyTitle')}
          </h1>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={handleExportVisibleHistory}
            className="flex-1 sm:flex-initial px-3 py-1.5 sm:px-3.5 sm:py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-bold border border-slate-700 flex items-center justify-center gap-1.5 transition-all"
          >
            <Download className="w-3.5 h-3.5 sm:w-4 sm:h-4 text-emerald-400" />
            <span>{t('exportCsv')}</span>
          </button>

        </div>
      </div>

      {/* Main Search Input & Filters Toggle Bar */}
      <div className="space-y-3">
        <div className="flex items-center gap-2">
          <div className="relative flex-1">
            <Search className="w-4 h-4 text-slate-500 absolute left-3.5 top-2.5 sm:top-3" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => {
                setSearchQuery(e.target.value);
                setCurrentPage(1);
              }}
              placeholder={t('searchQueryPlaceholder')}
              className="w-full bg-slate-900 border border-slate-800 rounded-xl pl-10 pr-4 py-2 sm:py-2.5 text-xs text-white placeholder:text-slate-500 focus:outline-none focus:border-cyan-500 transition-colors"
            />
          </div>

          <button
            type="button"
            onClick={() => setShowFilterDrawer(!showFilterDrawer)}
            className={`px-3 sm:px-4 py-2 sm:py-2.5 rounded-xl border text-xs font-bold flex items-center gap-1.5 sm:gap-2 transition-all shrink-0 ${
              showFilterDrawer || statusMatchFilter !== 'ALL' || sortOrder !== 'NEWEST' || filterType !== 'ALL'
                ? 'bg-cyan-950 text-cyan-300 border-cyan-500/60 shadow-md'
                : 'bg-slate-900 border-slate-800 text-slate-300 hover:text-white'
            }`}
          >
            <SlidersHorizontal className="w-4 h-4 text-cyan-400" />
            <span>{t('filterAndSort')}</span>
          </button>
        </div>

        {/* Expandable Clean Filter Panel */}
        {showFilterDrawer && (
          <div className="bg-slate-900/90 border border-slate-800 rounded-2xl p-3.5 sm:p-4 shadow-xl backdrop-blur-md space-y-4 animate-in fade-in slide-in-from-top-2 duration-200">
            {/* Status Match Filter */}
            <div className="space-y-1.5">
              <span className="text-[10px] font-bold text-slate-400 uppercase tracking-widest block">
                {t('matchStatusHeader')}
              </span>
              <div className="flex flex-wrap items-center gap-1.5 sm:gap-2">
                {[
                  { id: 'ALL', label: language === 'BM' ? 'SEMUA' : 'ALL' },
                  { id: 'EXACT', label: language === 'BM' ? 'PADANAN KES' : 'EXACT MATCH' },
                  { id: 'POSSIBLE', label: language === 'BM' ? 'BERPOTENSI' : 'POSSIBLE' },
                  { id: 'NONE', label: language === 'BM' ? 'TIADA' : 'UNMATCHED' },
                ].map((s) => (
                  <button
                    key={s.id}
                    onClick={() => {
                      setStatusMatchFilter(s.id as any);
                      setCurrentPage(1);
                    }}
                    className={`px-2.5 py-1 rounded-lg border text-[11px] font-bold uppercase transition-all ${
                      statusMatchFilter === s.id
                        ? 'bg-cyan-950 text-cyan-300 border-cyan-400 shadow-sm'
                        : 'bg-slate-950/60 border-slate-800 text-slate-400 hover:text-white'
                    }`}
                  >
                    {s.label}
                  </button>
                ))}
              </div>
            </div>

            {/* Sort Order & Event Type Filter Grid */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 sm:gap-4 border-t border-slate-800 pt-3">
              {/* Sort Order Selector */}
              <div className="space-y-1.5">
                <span className="text-[10px] font-bold text-slate-400 uppercase tracking-widest block flex items-center gap-1">
                  <ArrowUpDown className="w-3.5 h-3.5 text-cyan-400" />
                  <span>{t('sortByHeader')}</span>
                </span>
                <div className="flex items-center gap-1.5">
                  {[
                    { id: 'NEWEST', label: t('sortNewest') },
                    { id: 'OLDEST', label: t('sortOldest') },
                    { id: 'PLATE_AZ', label: t('sortPlateAZ') },
                  ].map((so) => (
                    <button
                      key={so.id}
                      onClick={() => setSortOrder(so.id as any)}
                      className={`px-2.5 py-1 rounded-lg border text-[11px] font-bold transition-all ${
                        sortOrder === so.id
                          ? 'bg-cyan-950 text-cyan-300 border-cyan-500/60'
                          : 'bg-slate-950/60 border-slate-800 text-slate-400 hover:text-white'
                      }`}
                    >
                      {so.label}
                    </button>
                  ))}
                </div>
              </div>

              {/* Event Type Filter */}
              <div className="space-y-1.5">
                <span className="text-[10px] font-bold text-slate-400 uppercase tracking-widest block">
                  {language === 'BM' ? 'KATEGORI LOG:' : 'LOG CATEGORY:'}
                </span>
                <div className="flex flex-wrap items-center gap-1.5">
                  {[
                    { id: 'ALL', label: t('filterAll') },
                    { id: 'SEARCH', label: t('filterSearch') },
                    { id: 'DETECTION', label: t('filterDetection') },
                    { id: 'VEHICLE', label: t('filterVehicle') },
                  ].map((cat) => (
                    <button
                      key={cat.id}
                      onClick={() => {
                        setFilterType(cat.id as any);
                        setCurrentPage(1);
                      }}
                      className={`px-2.5 py-1 rounded-lg border text-[11px] font-bold transition-all ${
                        filterType === cat.id
                          ? 'bg-cyan-950 text-cyan-300 border-cyan-500/60'
                          : 'bg-slate-950/60 border-slate-800 text-slate-400 hover:text-white'
                      }`}
                    >
                      {cat.label}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* History Log Container */}
      <div className="bg-slate-900/90 border border-slate-800 rounded-2xl shadow-xl overflow-hidden flex flex-col justify-between">
        {/* Mobile View: Cards */}
        <div className="sm:hidden p-3 space-y-2.5">
          {paginatedLogs.length > 0 ? (
            paginatedLogs.map((log) => {
              const isTandaTindakan = log.statusMatch === 'EXACT' || log.action.includes('Tanda Tindakan');
              return (
                <div key={log.id} className="p-3.5 rounded-2xl bg-slate-950/80 border border-slate-800 space-y-2.5 shadow-sm">
                  {/* Top Bar: Event Badges + Date Timestamp */}
                  <div className="flex flex-wrap items-center justify-between gap-1.5 pb-2 border-b border-slate-800/50">
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <span
                        className={`inline-flex items-center justify-center w-20 px-2 py-0.5 rounded text-[9px] font-bold uppercase ${
                          log.type === 'DETECTION'
                            ? 'bg-blue-950 text-blue-300 border border-blue-700'
                            : log.type === 'SEARCH'
                            ? 'bg-cyan-950 text-cyan-300 border border-cyan-700'
                            : log.type === 'VEHICLE'
                            ? 'bg-purple-950 text-purple-300 border border-purple-700'
                            : 'bg-amber-950 text-amber-300 border border-amber-700'
                        }`}
                      >
                        {log.type}
                      </span>
                      {isTandaTindakan && (
                        <span className="inline-flex items-center justify-center px-2 py-0.5 rounded text-[9px] font-black uppercase bg-cyan-950 text-cyan-300 border border-cyan-700 whitespace-nowrap">
                          TANDA TINDAKAN
                        </span>
                      )}
                    </div>
                    <span className="text-[10px] font-mono text-slate-400 shrink-0 ml-auto">{formatDate(log.timestamp)}</span>
                  </div>

                  {/* Plate Number & Main Content */}
                  <div className="space-y-1">
                    {log.plate && (
                      <span className="inline-flex items-center justify-center w-24 font-mono font-black text-xs text-cyan-400 bg-slate-900 px-2 py-0.5 rounded border border-cyan-900/50">
                        {log.plate}
                      </span>
                    )}
                    <p className="text-xs text-slate-200 font-sans font-medium leading-relaxed">{log.note || log.details}</p>
                  </div>

                  {/* Footer: Role */}
                  {showRoleColumn && (
                    <div className="text-[10px] text-slate-400 font-mono text-right pt-1.5 border-t border-slate-800/40">
                      Role: <span className="font-bold text-white">{log.userRole}</span>
                    </div>
                  )}
                </div>
              );
            })
          ) : (
            <div className="py-6 text-center text-xs text-slate-500 font-sans">{t('noHistory')}</div>
          )}
        </div>

        {/* Desktop View: Table */}
        <div className="hidden sm:block overflow-x-auto">
          <table className="w-full text-left text-xs min-w-[700px] border-collapse">
            <thead className="bg-slate-950/90 text-slate-400 uppercase font-mono text-[10px] border-b border-slate-800 whitespace-nowrap">
              <tr>
                <th className="py-3.5 px-4">{t('eventType')}</th>
                <th className="py-3.5 px-4">{t('plateNumber')}</th>
                <th className="py-3.5 px-4">{t('tindakanCol')}</th>
                <th className="py-3.5 px-4">{t('notaTindakanCol')}</th>
                {showRoleColumn && <th className="py-3.5 px-4">{t('roleHeader')}</th>}
                <th className="py-3.5 px-4 text-right">{t('timestamp')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/60 font-mono whitespace-nowrap">
              {paginatedLogs.length > 0 ? (
                paginatedLogs.map((log) => {
                  const isTandaTindakan = log.statusMatch === 'EXACT' || log.action.includes('Tanda Tindakan');
                  return (
                    <tr key={log.id} className="hover:bg-slate-800/40 transition-colors">
                      <td className="py-3 px-4 font-sans">
                        <span
                          className={`inline-flex items-center justify-center w-24 px-2.5 py-1 rounded text-[10px] font-bold uppercase ${
                            log.type === 'DETECTION'
                              ? 'bg-blue-950 text-blue-300 border border-blue-700'
                              : log.type === 'SEARCH'
                              ? 'bg-cyan-950 text-cyan-300 border border-cyan-700'
                              : log.type === 'VEHICLE'
                              ? 'bg-purple-950 text-purple-300 border border-purple-700'
                              : 'bg-amber-950 text-amber-300 border border-amber-700'
                          }`}
                        >
                          {log.type}
                        </span>
                      </td>
                      <td className="py-3 px-4">
                        {log.plate ? (
                          <span className="inline-flex items-center justify-center w-24 font-black text-cyan-400 bg-slate-950 px-2 py-0.5 rounded border border-cyan-900/50">
                            {log.plate}
                          </span>
                        ) : (
                          <span className="text-slate-600">-</span>
                        )}
                      </td>
                      <td className="py-3 px-4">
                        {isTandaTindakan ? (
                          <span className="inline-flex items-center justify-center min-w-[130px] px-3 py-1 rounded text-[10px] font-black uppercase bg-cyan-950 text-cyan-300 border border-cyan-700 whitespace-nowrap shadow-sm">
                            TANDA TINDAKAN
                          </span>
                        ) : (
                          <span className="text-slate-600 font-mono text-[10px]">-</span>
                        )}
                      </td>
                      <td className="py-3 px-4 font-sans text-slate-200 font-medium">
                        {log.note || log.details || <span className="text-slate-600 italic">-</span>}
                      </td>
                      {showRoleColumn && (
                        <td className="py-3 px-4 text-slate-400 text-[11px]">{log.userRole}</td>
                      )}
                      <td className="py-3 px-4 text-right text-slate-500 text-[11px]">
                        {formatDate(log.timestamp)}
                      </td>
                    </tr>
                  );
                })
              ) : (
                <tr>
                  <td colSpan={showRoleColumn ? 6 : 5} className="py-10 text-center text-slate-500 font-sans">
                    {t('noHistory')}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        {/* Pagination & Rows Selector Footer */}
        <div className="px-4 py-3 bg-slate-950/90 border-t border-slate-800 flex flex-col sm:flex-row items-center justify-between gap-3 text-xs">
          {/* Rows Per Page Dropdown */}
          <div className="flex items-center gap-2 text-slate-400">
            <span>{t('itemsPerPage')}</span>
            <select
              value={pageSize}
              onChange={(e) => {
                setPageSize(Number(e.target.value));
                setCurrentPage(1);
              }}
              className="bg-slate-900 border border-slate-800 rounded-lg px-2 py-1 text-xs text-white focus:outline-none cursor-pointer font-mono"
            >
              <option value={10}>10</option>
              <option value={20}>20</option>
              <option value={50}>50</option>
            </select>
          </div>

          {/* Record Counter */}
          <div className="text-slate-400 font-mono text-[11px]">
            {t('showingRecords')}{' '}
            <strong className="text-cyan-400">{totalItems > 0 ? startIndex + 1 : 0}</strong>{' '}
            -{' '}
            <strong className="text-cyan-400">{Math.min(startIndex + pageSize, totalItems)}</strong>{' '}
            {t('ofRecords')}{' '}
            <strong className="text-white">{totalItems}</strong> {t('records')}
          </div>

          {/* Page Controls */}
          <div className="flex items-center gap-1.5">
            <button
              onClick={() => setCurrentPage((p) => Math.max(p - 1, 1))}
              disabled={safeCurrentPage === 1}
              className="p-1.5 rounded-lg bg-slate-900 border border-slate-800 text-slate-300 hover:bg-slate-800 disabled:opacity-40 disabled:cursor-not-allowed transition-all"
            >
              <ChevronLeft className="w-4 h-4" />
            </button>

            <span className="px-3 py-1 font-mono text-xs text-cyan-300 font-bold bg-cyan-950/80 border border-cyan-800/80 rounded-lg">
              {t('page')} {safeCurrentPage} {t('ofRecords')} {totalPages}
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
    </div>
  );
}
