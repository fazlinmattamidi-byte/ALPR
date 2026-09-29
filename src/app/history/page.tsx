'use client';

import React, { useState } from 'react';
import { useStorage } from '@/context/StorageContext';
import { useLanguage } from '@/context/LanguageContext';
import { downloadCSV, formatDate } from '@/lib/utils';
import {
  Download,
  Search,
  ChevronLeft,
  ChevronRight,
  SlidersHorizontal,
  ArrowUpDown,
} from 'lucide-react';
import { useAuth } from '@/context/AuthContext';

type HistoryFilterType = 'ALL' | 'SEARCH' | 'DETECTION' | 'ACTION' | 'STATUS_CHANGE' | 'VEHICLE' | 'USER';
type MatchStatusFilter = 'ALL' | 'EXACT' | 'POSSIBLE' | 'NONE';
type HistorySortOrder = 'NEWEST' | 'OLDEST' | 'PLATE_AZ';

function createHistoryExportFileName(role: string): string {
  return `track_audit_history_${role.toLowerCase()}_${Date.now()}.csv`;
}

function formatAuditCompactTime(isoString: string): string {
  if (!isoString) return '-';
  try {
    const d = new Date(isoString);
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Asia/Kuala_Lumpur',
      day: '2-digit',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(d)
      .reduce<Record<string, string>>((acc, part) => {
        if (part.type !== 'literal') acc[part.type] = part.value;
        return acc;
      }, {});

    return `${parts.day} ${parts.month}, ${parts.hour}:${parts.minute}`;
  } catch {
    return isoString;
  }
}

export default function HistoryPage() {
  const { history, users } = useStorage();
  const { t, language } = useLanguage();
  const { currentUser, role } = useAuth();

  const showRoleColumn = role === 'SUPER_ADMIN';
  const adminUserIds = users.filter((user) => user.createdBy === currentUser?.id).map((user) => user.id);
  const visibleAuditLogs = history.filter((log) => {
    const isOperationalLog = log.type === 'SEARCH' || log.type === 'DETECTION' || log.type === 'ACTION' || log.type === 'STATUS_CHANGE';
    if (role === 'USER' && !isOperationalLog) return false;
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
  const [filterType, setFilterType] = useState<HistoryFilterType>('ALL');
  const [statusMatchFilter, setStatusMatchFilter] = useState<MatchStatusFilter>('ALL');
  const [sortOrder, setSortOrder] = useState<HistorySortOrder>('NEWEST');
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
    const camera = `${h.cameraId || ''} ${h.cameraName || ''}`.toLowerCase();

    const matchesSearch = !searchQuery || p.includes(q) || act.includes(q) || det.includes(q) || camera.includes(q);
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
  const activeFilterCount =
    (filterType !== 'ALL' ? 1 : 0) +
    (statusMatchFilter !== 'ALL' ? 1 : 0) +
    (sortOrder !== 'NEWEST' ? 1 : 0);

  const statusOptions = [
    { id: 'ALL', label: language === 'BM' ? 'Semua' : 'All' },
    { id: 'EXACT', label: language === 'BM' ? 'Padan' : 'Exact' },
    { id: 'POSSIBLE', label: language === 'BM' ? 'Mungkin' : 'Maybe' },
    { id: 'NONE', label: language === 'BM' ? 'Tiada' : 'None' },
  ] satisfies Array<{ id: MatchStatusFilter; label: string }>;

  const sortOptions = [
    { id: 'NEWEST', label: language === 'BM' ? 'Baru' : 'Newest' },
    { id: 'OLDEST', label: language === 'BM' ? 'Lama' : 'Oldest' },
    { id: 'PLATE_AZ', label: language === 'BM' ? 'Plat A-Z' : 'Plate A-Z' },
  ] satisfies Array<{ id: HistorySortOrder; label: string }>;

  const categoryOptions = [
    { id: 'ALL', label: language === 'BM' ? 'Semua' : 'All' },
    { id: 'DETECTION', label: language === 'BM' ? 'Imbasan' : 'Scan' },
    { id: 'ACTION', label: language === 'BM' ? 'Tindakan' : 'Action' },
    { id: 'SEARCH', label: language === 'BM' ? 'Carian' : 'Search' },
    { id: 'VEHICLE', label: language === 'BM' ? 'Kenderaan' : 'Vehicle' },
  ] satisfies Array<{ id: HistoryFilterType; label: string }>;

  const handleExportVisibleHistory = () => {
    const headers = 'ID,Type,Action,Plate,Details,Actor,Timestamp,MatchStatus,CameraID,CameraName\n';
    const rows = filteredLogs
      .map(
        (h) =>
          `"${h.id}","${h.type}","${h.action}","${h.plate || ''}","${h.details}","${h.actorName || h.userRole}","${formatDate(
            h.timestamp
          )}","${h.statusMatch || ''}","${h.cameraId || ''}","${h.cameraName || ''}"`
      )
      .join('\n');
    downloadCSV(createHistoryExportFileName(role), headers + rows);
  };

  return (
    <div className="audit-page space-y-4 sm:space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between gap-3 sm:items-center">
        <div className="min-w-0">
          <h1 className="text-[1.65rem] sm:text-2xl font-black text-white tracking-wide leading-[1.08]">
            <span className="sm:hidden">{language === 'BM' ? 'Sejarah Audit' : 'Audit History'}</span>
            <span className="hidden sm:inline">{t('historyTitle')}</span>
          </h1>
          <p className="mt-1 text-xs font-medium text-slate-400 sm:hidden">
            {totalItems} {language === 'BM' ? 'rekod' : 'records'}
          </p>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          <button
            onClick={handleExportVisibleHistory}
            className="audit-export-button h-10 px-3 sm:h-auto sm:px-3.5 sm:py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-bold border border-slate-700 flex items-center justify-center gap-2 transition-all"
            aria-label={t('exportCsv')}
          >
            <Download className="w-3.5 h-3.5 sm:w-4 sm:h-4 text-emerald-400" />
            <span className="sm:hidden">CSV</span>
            <span className="hidden sm:inline">{t('exportCsv')}</span>
          </button>
        </div>
      </div>

      {/* Main Search Input & Filters Toggle Bar */}
      <div className="audit-toolbar space-y-2.5 rounded-2xl border border-slate-800 bg-slate-900/90 p-2.5 shadow-xl backdrop-blur-md sm:space-y-3 sm:p-0 sm:bg-transparent sm:border-0 sm:shadow-none">
        <div className="flex items-center gap-2 sm:gap-3">
          <div className="relative min-w-0 flex-1">
            <Search className="w-4 h-4 text-slate-500 absolute left-3.5 top-3.5 sm:top-3" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => {
                setSearchQuery(e.target.value);
                setCurrentPage(1);
              }}
              placeholder={t('searchQueryPlaceholder')}
              className="audit-search-input h-11 w-full bg-slate-950 border border-slate-800 rounded-xl pl-10 pr-4 text-sm sm:text-xs text-white placeholder:text-slate-500 focus:outline-none focus:border-cyan-500 transition-colors sm:h-auto sm:bg-slate-900 sm:py-2.5"
            />
          </div>

          <button
            type="button"
            onClick={() => setShowFilterDrawer(!showFilterDrawer)}
            className={`audit-filter-toggle relative h-11 w-11 sm:h-auto sm:w-auto sm:px-4 sm:py-2.5 rounded-xl border text-xs font-bold flex items-center justify-center gap-2 transition-all shrink-0 ${
              showFilterDrawer || statusMatchFilter !== 'ALL' || sortOrder !== 'NEWEST' || filterType !== 'ALL'
                ? 'bg-cyan-950 text-cyan-300 border-cyan-500/60 shadow-md'
                : 'bg-slate-900 border-slate-800 text-slate-300 hover:text-white'
            }`}
            aria-label={t('filterAndSort')}
          >
            <SlidersHorizontal className="w-4 h-4 text-cyan-400" />
            <span className="hidden sm:inline">{t('filterAndSort')}</span>
            {activeFilterCount > 0 && (
              <span className="absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-cyan-500 px-1 text-[9px] font-black text-slate-950 sm:hidden">
                {activeFilterCount}
              </span>
            )}
          </button>
        </div>

        {/* Expandable Clean Filter Panel */}
        {showFilterDrawer && (
          <div className="audit-filter-panel bg-slate-900/90 border border-slate-800 rounded-2xl p-3 shadow-xl backdrop-blur-md space-y-3 animate-in fade-in slide-in-from-top-2 duration-200 sm:p-4 sm:space-y-4">
            <div className="flex items-center justify-between sm:hidden">
              <span className="text-[11px] font-black uppercase tracking-[0.18em] text-slate-300">
                {language === 'BM' ? 'Penapis' : 'Filters'}
              </span>
              <span className="text-[10px] font-mono text-slate-500">
                {paginatedLogs.length}/{totalItems}
              </span>
            </div>

            {/* Status Match Filter */}
            <div className="space-y-2">
              <span className="text-[10px] font-bold text-slate-400 uppercase tracking-[0.16em] block">
                {language === 'BM' ? 'Status' : 'Status'}
              </span>
              <div className="grid grid-cols-4 gap-1.5 sm:flex sm:flex-wrap sm:items-center sm:gap-2">
                {statusOptions.map((s) => (
                  <button
                    key={s.id}
                    onClick={() => {
                      setStatusMatchFilter(s.id);
                      setCurrentPage(1);
                    }}
                    className={`audit-filter-chip h-8 rounded-lg px-2 text-[11px] font-bold transition-all sm:h-auto sm:py-1 ${
                      statusMatchFilter === s.id
                        ? 'audit-filter-chip-active'
                        : ''
                    }`}
                  >
                    {s.label}
                  </button>
                ))}
              </div>
            </div>

            {/* Sort Order & Event Type Filter Grid */}
            <div className="grid grid-cols-1 gap-3 border-t border-slate-800 pt-3 sm:grid-cols-2 sm:gap-4">
              {/* Sort Order Selector */}
              <div className="space-y-2">
                <span className="flex items-center gap-1 text-[10px] font-bold text-slate-400 uppercase tracking-[0.16em]">
                  <ArrowUpDown className="w-3.5 h-3.5 text-cyan-400" />
                  <span>{language === 'BM' ? 'Susun' : 'Sort'}</span>
                </span>
                <div className="grid grid-cols-3 gap-1.5 sm:flex sm:items-center">
                  {sortOptions.map((so) => (
                    <button
                      key={so.id}
                      onClick={() => setSortOrder(so.id)}
                      className={`audit-filter-chip h-8 rounded-lg px-2 text-[11px] font-bold leading-tight transition-all sm:h-auto sm:py-1 ${
                        sortOrder === so.id
                          ? 'audit-filter-chip-active'
                          : ''
                      }`}
                    >
                      {so.label}
                    </button>
                  ))}
                </div>
              </div>

              {/* Event Type Filter */}
              <div className="space-y-2">
                <span className="text-[10px] font-bold text-slate-400 uppercase tracking-[0.16em] block">
                  {language === 'BM' ? 'Kategori' : 'Category'}
                </span>
                <div className="grid grid-cols-4 gap-1.5 sm:flex sm:flex-wrap sm:items-center">
                  {categoryOptions.map((cat) => (
                    <button
                      key={cat.id}
                      onClick={() => {
                        setFilterType(cat.id);
                        setCurrentPage(1);
                      }}
                      className={`audit-filter-chip h-8 rounded-lg px-1.5 text-[11px] font-bold transition-all sm:h-auto sm:px-2.5 sm:py-1 ${
                        filterType === cat.id
                          ? 'audit-filter-chip-active'
                          : ''
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
      <div className="audit-list-wrap sm:bg-slate-900/90 sm:border sm:border-slate-800 sm:rounded-2xl sm:shadow-xl sm:overflow-hidden sm:flex sm:flex-col sm:justify-between">
        {/* Mobile View: Cards */}
        <div className="sm:hidden space-y-2.5">
          {paginatedLogs.length > 0 ? (
            paginatedLogs.map((log) => {
              const isTandaTindakan = log.statusMatch === 'EXACT' || log.action.includes('Tanda Tindakan');
              return (
                <article key={log.id} className="audit-log-card rounded-2xl border border-slate-800 bg-slate-900/90 p-3.5 shadow-xl">
                  {/* Top Bar: Event Badges + Date Timestamp */}
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="mb-2 flex min-w-0 items-center gap-1.5">
                      <span
                        className={`audit-type-chip inline-flex shrink-0 items-center justify-center rounded-md px-2 py-1 text-[10px] font-bold uppercase ${
                          log.type === 'DETECTION'
                            ? 'audit-type-detection bg-blue-950 text-blue-300 border border-blue-700'
                            : log.type === 'ACTION'
                            ? 'audit-type-action bg-emerald-950 text-emerald-300 border border-emerald-700'
                            : log.type === 'STATUS_CHANGE'
                            ? 'audit-type-status bg-amber-950 text-amber-300 border border-amber-700'
                            : log.type === 'SEARCH'
                            ? 'audit-type-search bg-cyan-950 text-cyan-300 border border-cyan-700'
                            : log.type === 'VEHICLE'
                            ? 'audit-type-vehicle bg-purple-950 text-purple-300 border border-purple-700'
                            : 'audit-type-user bg-amber-950 text-amber-300 border border-amber-700'
                        }`}
                      >
                        {log.type === 'DETECTION'
                          ? language === 'BM'
                            ? 'Imbas'
                            : 'Scan'
                          : log.type === 'ACTION'
                          ? language === 'BM'
                            ? 'Tindakan'
                            : 'Action'
                          : log.type === 'SEARCH'
                          ? language === 'BM'
                            ? 'Cari'
                            : 'Search'
                          : log.type}
                      </span>
                      {isTandaTindakan && (
                        <span className="audit-type-chip audit-action-chip inline-flex shrink-0 items-center justify-center rounded-md bg-cyan-950 px-2 py-1 text-[10px] font-black uppercase text-cyan-300 border border-cyan-700">
                          {language === 'BM' ? 'Tindakan' : 'Action'}
                        </span>
                      )}
                      </div>
                      {log.plate && (
                        <span className="block truncate font-mono text-lg font-black leading-none text-cyan-300">
                          {log.plate}
                        </span>
                      )}
                    </div>
                    <time className="shrink-0 pt-0.5 text-[11px] font-mono text-slate-500">
                      {formatAuditCompactTime(log.timestamp)}
                    </time>
                  </div>

                  {/* Plate Number & Main Content */}
                  <div className="mt-2 space-y-1.5">
                    <p className="line-clamp-2 text-[13px] text-slate-200 font-sans font-medium leading-snug">{log.note || log.details}</p>
                    {(log.cameraName || log.cameraId) && (
                      <p className="text-[11px] font-mono text-slate-500 truncate">
                        {log.cameraName || log.cameraId}
                      </p>
                    )}
                  </div>

                  {/* Footer: Role */}
                  {showRoleColumn && (
                    <div className="mt-2 flex justify-end text-[10px] text-slate-400 font-mono">
                      <span className="audit-role-pill rounded-md border border-slate-800 px-2 py-1">
                        {t('roleHeader')}: <span className="font-bold text-white">{log.userRole}</span>
                      </span>
                    </div>
                  )}
                </article>
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
                              : log.type === 'ACTION'
                              ? 'bg-emerald-950 text-emerald-300 border border-emerald-700'
                              : log.type === 'STATUS_CHANGE'
                              ? 'bg-amber-950 text-amber-300 border border-amber-700'
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
                        <div>{log.note || log.details || <span className="text-slate-600 italic">-</span>}</div>
                        {(log.cameraName || log.cameraId) && (
                          <div className="mt-1 font-mono text-[10px] text-slate-500">
                            {log.cameraName || log.cameraId}
                          </div>
                        )}
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
        <div className="audit-pagination mt-3 rounded-2xl border border-slate-800 bg-slate-900/90 px-4 py-3 shadow-xl flex flex-col sm:mt-0 sm:rounded-none sm:border-0 sm:border-t sm:bg-slate-950/90 sm:shadow-none sm:flex-row items-center justify-between gap-3 text-xs">
          {/* Rows Per Page Dropdown */}
          <div className="hidden sm:flex items-center gap-2 text-slate-400">
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
          <div className="hidden sm:block text-slate-400 font-mono text-[11px]">
            {t('showingRecords')}{' '}
            <strong className="text-cyan-400">{totalItems > 0 ? startIndex + 1 : 0}</strong>{' '}
            -{' '}
            <strong className="text-cyan-400">{Math.min(startIndex + pageSize, totalItems)}</strong>{' '}
            {t('ofRecords')}{' '}
            <strong className="text-white">{totalItems}</strong> {t('records')}
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
