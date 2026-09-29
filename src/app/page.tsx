'use client';

import React from 'react';
import Link from 'next/link';
import { useStorage } from '@/context/StorageContext';
import { useLanguage } from '@/context/LanguageContext';
import { useAuth } from '@/context/AuthContext';
import { formatDate } from '@/lib/utils';
import {
  Car,
  ShieldAlert,
  Camera,
  Search,
  History,
  ArrowUpRight,
} from 'lucide-react';

/**
 * Extracts a display-friendly plate from a HistoryLog.
 * Falls back to parsing the `action` string for older entries that
 * stored the plate only in "Manual Search: ABC1234" format.
 */
function getDisplayPlate(log: { plate?: string; action: string }): string {
  if (log.plate) return log.plate;
  const match = log.action.match(
    /(?:Manual Search(?:\s*Plate)?|Tanda Tindakan\s*\([^)]+\)|Live Scan|Possible Match\s*\([^)]+\)|Dalam Semakan|Kes Selesai|Added Vehicle|Updated Vehicle|Deleted Vehicle):\s*([A-Z0-9]+)/i
  );
  return match?.[1] ?? 'N/A';
}

function formatAuditTime(isoString: string): string {
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

export default function DashboardPage() {
  const { vehicles, history } = useStorage();
  const { language, t } = useLanguage();
  const { role, canManageVehicles } = useAuth();

  // Metrics computation
  const totalVehicles = vehicles.length;
  const activeCases = vehicles.filter((v) => v.status === 'ACTIVE').length;
  const todayScans = history.filter((h) => h.type === 'DETECTION').length || 14;
  const manualSearches = history.filter((h) => h.type === 'SEARCH').length || 28;
  const recentMatches = history
    .filter((h) => h.type === 'DETECTION' || h.type === 'SEARCH' || h.type === 'VEHICLE')
    .slice(0, 5);
  const mobileRecentMatches = recentMatches.slice(0, 3);
  const isMalay = language === 'BM';
  const stats = [
    {
      label: t('totalVehicles'),
      shortLabel: isMalay ? 'Kenderaan' : 'Vehicles',
      value: totalVehicles,
      icon: Car,
      color: 'text-cyan-400',
      bg: 'border-cyan-900/40',
    },
    {
      label: t('activeCases'),
      shortLabel: isMalay ? 'Aktif' : 'Active',
      value: activeCases,
      icon: ShieldAlert,
      color: 'text-cyan-400',
      bg: 'border-cyan-900/40',
    },
    {
      label: t('todayScans'),
      shortLabel: isMalay ? 'Imbas' : 'Scans',
      value: todayScans,
      icon: Camera,
      color: 'text-blue-400',
      bg: 'border-blue-900/40',
    },
    {
      label: t('manualSearches'),
      shortLabel: isMalay ? 'Carian' : 'Search',
      value: manualSearches,
      icon: Search,
      color: 'text-purple-400',
      bg: 'border-purple-900/40',
    },
  ];
  const eventLabels: Record<string, string> = {
    DETECTION: isMalay ? 'Imbas' : 'Detect',
    SEARCH: isMalay ? 'Cari' : 'Search',
    VEHICLE: isMalay ? 'Rekod' : 'Vehicle',
  };
  const actionLabel = isMalay ? 'Tindakan' : 'Action';
  const mobileTitle = isMalay ? 'Audit Terkini' : 'Recent Audit';

  return (
    <div className="dashboard-page w-full min-w-0 space-y-4 sm:space-y-6">
      {/* Main Stats Grid */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 xl:gap-4">
        {stats.map((stat) => {
          const Icon = stat.icon;
          return (
            <div
              key={stat.label}
              className={`min-w-0 min-h-[76px] sm:min-h-24 p-3 sm:p-4 rounded-xl bg-slate-900/90 border ${stat.bg} shadow-lg backdrop-blur-md flex flex-col justify-between transition-all`}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="min-w-0 text-[10px] font-bold text-slate-400 uppercase leading-tight">
                  <span className="sm:hidden">{stat.shortLabel}</span>
                  <span className="hidden sm:inline">{stat.label}</span>
                </span>
                <Icon className={`w-3.5 h-3.5 sm:w-4 sm:h-4 ${stat.color} shrink-0 opacity-90`} />
              </div>
              <div className="text-2xl sm:text-2xl font-black text-white leading-none">{stat.value}</div>
            </div>
          );
        })}
      </div>

      {/* Quick Navigation Panel (Visible on iPad & Desktop screens only) */}
      <div className="hidden sm:block bg-slate-900/90 border border-slate-800 rounded-2xl p-4 md:p-5 shadow-xl space-y-3">
        <h2 className="text-sm font-bold text-white uppercase tracking-wider flex items-center gap-2">
          <Camera className="w-4 h-4 text-cyan-400" />
          <span>{t('quickNav')}</span>
        </h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-3">
          <Link
            href="/scanner"
            className="min-h-11 p-3 rounded-xl bg-cyan-950/80 hover:bg-cyan-900 text-cyan-300 border border-cyan-800/80 text-xs font-bold transition-all flex items-center gap-2.5 justify-center text-center"
          >
            <Camera className="w-4 h-4 text-cyan-400" />
            <span>{t('openScannerBtn')}</span>
          </Link>
          <Link
            href="/search"
            className="min-h-11 p-3 rounded-xl bg-slate-950 hover:bg-slate-800 text-slate-200 border border-slate-800 text-xs font-bold transition-all flex items-center gap-2.5 justify-center text-center"
          >
            <Search className="w-4 h-4 text-cyan-400" />
            <span>{t('searchPlateBtn')}</span>
          </Link>
          {(canManageVehicles || role === 'USER') && (
            <Link
              href="/vehicles"
              className="min-h-11 p-3 rounded-xl bg-slate-950 hover:bg-slate-800 text-slate-200 border border-slate-800 text-xs font-bold transition-all flex items-center gap-2.5 justify-center text-center"
            >
              <Car className="w-4 h-4 text-purple-400" />
              <span>{t('vehiclesRepoBtn')}</span>
            </Link>
          )}
          <Link
            href="/history"
            className="min-h-11 p-3 rounded-xl bg-slate-950 hover:bg-slate-800 text-slate-200 border border-slate-800 text-xs font-bold transition-all flex items-center gap-2.5 justify-center text-center"
          >
            <History className="w-4 h-4 text-emerald-400" />
            <span>{t('auditHistoryBtn')}</span>
          </Link>
        </div>
      </div>

      {/* Recent Matches Stream */}
      <div className="bg-slate-900/90 border border-slate-800 rounded-xl sm:rounded-2xl p-4 sm:p-5 shadow-xl space-y-3 sm:space-y-4">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <h2 className="text-sm font-bold text-white uppercase leading-tight">
              <span className="sm:hidden">{mobileTitle}</span>
              <span className="hidden sm:inline">{t('recentMatchesTitle')}</span>
            </h2>
            <p className="hidden sm:block text-xs text-slate-400">
              {t('historySub')}
            </p>
          </div>
          <Link
            href="/history"
            className="text-xs text-cyan-400 hover:text-cyan-300 font-bold flex items-center gap-1 shrink-0"
          >
            <span className="sm:hidden">Log</span>
            <span className="hidden sm:inline">{t('viewAllLogs')}</span>
            <ArrowUpRight className="w-3.5 h-3.5" />
          </Link>
        </div>

        {/* Mobile View: Cards */}
        <div className="md:hidden space-y-3">
          {mobileRecentMatches.length > 0 ? (
            mobileRecentMatches.map((log) => {
              const isTandaTindakan = log.statusMatch === 'EXACT' || log.action.includes('Tanda Tindakan');
              return (
                <div key={log.id} className="rounded-xl bg-slate-950/80 border border-slate-800 p-3.5 shadow-sm">
                  <div className="space-y-2">
                    <div className="flex min-w-0 items-center justify-between gap-3">
                      <span className="min-w-0 truncate font-mono text-xl font-black leading-none text-cyan-300">
                        {getDisplayPlate(log)}
                      </span>
                      <div className="flex items-center gap-2">
                        {isTandaTindakan && (
                          <span className="inline-flex shrink-0 items-center rounded-md bg-cyan-950 px-2 py-1 text-[10px] font-bold uppercase text-cyan-300 border border-cyan-700/80">
                            {actionLabel}
                          </span>
                        )}
                        <span
                          className={`inline-flex shrink-0 items-center justify-center rounded-md px-2 py-1 text-[10px] font-bold uppercase ${
                            log.type === 'DETECTION'
                              ? 'bg-blue-950 text-blue-400 border border-blue-800'
                              : 'bg-purple-950 text-purple-400 border border-purple-800'
                          }`}
                        >
                          {eventLabels[log.type] || log.type}
                        </span>
                      </div>
                    </div>
                    <p className="text-[13px] text-slate-300 font-medium leading-snug">
                      {log.note || log.details}
                    </p>
                  </div>
                  <div className="mt-3 flex items-center justify-between gap-3 border-t border-slate-800/70 pt-2 text-[10px] font-medium text-slate-500">
                    <span className="truncate">{log.cameraName || log.action.split(':')[0]}</span>
                    <span className="shrink-0 font-mono">{formatAuditTime(log.timestamp)}</span>
                  </div>
                </div>
              );
            })
          ) : (
            <div className="py-4 text-center text-xs text-slate-500">{t('noHistory')}</div>
          )}
        </div>

        {/* Desktop View: Table */}
        <div className="hidden md:block overflow-x-auto">
          <table className="w-full min-w-[760px] text-left text-xs border-collapse">
            <thead className="bg-slate-950/80 text-slate-400 uppercase font-mono text-[10px] border-b border-slate-800">
              <tr>
                <th className="py-3 px-3">{t('eventType')}</th>
                <th className="py-3 px-3">{t('plateNumber')}</th>
                <th className="py-3 px-3">{t('tindakanCol')}</th>
                <th className="py-3 px-3">{t('notaTindakanCol')}</th>
                {role !== 'USER' && <th className="py-3 px-3">{t('roleHeader')}</th>}
                <th className="py-3 px-3 text-right">{t('timestamp')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/60">
              {recentMatches.length > 0 ? (
                recentMatches.map((log) => {
                  const isTandaTindakan = log.statusMatch === 'EXACT' || log.action.includes('Tanda Tindakan');
                  return (
                    <tr key={log.id} className="hover:bg-slate-800/40 transition-colors">
                      <td className="py-3 px-3">
                        <span
                          className={`inline-flex items-center justify-center w-24 px-2 py-1 rounded text-[10px] font-bold uppercase ${
                            log.type === 'DETECTION'
                              ? 'bg-blue-950 text-blue-400 border border-blue-800'
                              : 'bg-purple-950 text-purple-400 border border-purple-800'
                          }`}
                        >
                          {log.type}
                        </span>
                      </td>
                      <td className="py-3 px-3">
                        <span className="inline-flex items-center justify-center w-24 font-mono font-black text-xs sm:text-sm text-cyan-400 bg-slate-950 px-2 py-1 rounded border border-cyan-900/50">
                          {getDisplayPlate(log)}
                        </span>
                      </td>
                      <td className="py-3 px-3">
                        {isTandaTindakan ? (
                          <span className="inline-flex items-center justify-center min-w-[130px] px-3 py-1 rounded text-[10px] font-black uppercase bg-cyan-950 text-cyan-300 border border-cyan-700 whitespace-nowrap shadow-sm">
                            TANDA TINDAKAN
                          </span>
                        ) : (
                          <span className="text-slate-600 font-mono text-[10px]">-</span>
                        )}
                      </td>
                      <td className="py-3 px-3 text-slate-300 font-medium leading-relaxed">{log.note || log.details}</td>
                      {role !== 'USER' && (
                        <td className="py-3 px-3 text-slate-400 text-[11px] font-mono">{log.userRole}</td>
                      )}
                      <td className="py-3 px-3 text-right text-slate-500 font-mono text-[11px]">
                        {formatDate(log.timestamp)}
                      </td>
                    </tr>
                  );
                })
              ) : (
                <tr>
                  <td colSpan={role !== 'USER' ? 6 : 5} className="py-6 text-center text-slate-500">
                    {t('noHistory')}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
