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

export default function DashboardPage() {
  const { vehicles, history } = useStorage();
  const { t } = useLanguage();
  const { role, canManageVehicles } = useAuth();

  // Metrics computation
  const totalVehicles = vehicles.length;
  const activeCases = vehicles.filter((v) => v.status === 'ACTIVE').length;
  const todayScans = history.filter((h) => h.type === 'DETECTION').length || 14;
  const manualSearches = history.filter((h) => h.type === 'SEARCH').length || 28;
  const recentMatches = history
    .filter((h) => h.type === 'DETECTION' || h.type === 'SEARCH' || h.type === 'VEHICLE')
    .slice(0, 5);

  return (
    <div className="dashboard-page w-full min-w-0 space-y-4 sm:space-y-6">
      {/* Main Stats Grid */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-2.5 sm:gap-3 xl:gap-4">
        {[
          { label: t('totalVehicles'), value: totalVehicles, icon: Car, color: 'text-cyan-400', bg: 'border-cyan-900/40' },
          { label: t('activeCases'), value: activeCases, icon: ShieldAlert, color: 'text-cyan-400', bg: 'border-cyan-900/40' },
          { label: t('todayScans'), value: todayScans, icon: Camera, color: 'text-blue-400', bg: 'border-blue-900/40' },
          { label: t('manualSearches'), value: manualSearches, icon: Search, color: 'text-purple-400', bg: 'border-purple-900/40' },
        ].map((stat, i) => {
          const Icon = stat.icon;
          return (
            <div
              key={i}
              className={`min-h-20 p-3 sm:p-4 rounded-xl bg-slate-900/90 border ${stat.bg} shadow-lg backdrop-blur-md flex flex-col justify-between hover:scale-[1.02] transition-all`}
            >
              <div className="flex items-center justify-between gap-1">
                <span className="text-[9px] sm:text-[10px] font-bold text-slate-400 uppercase tracking-wider leading-tight whitespace-normal break-words">
                  {stat.label}
                </span>
                <Icon className={`w-3.5 h-3.5 sm:w-4 sm:h-4 ${stat.color} shrink-0`} />
              </div>
              <div className="text-xl sm:text-2xl font-black text-white mt-1.5 sm:mt-2">{stat.value}</div>
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
      <div className="bg-slate-900/90 border border-slate-800 rounded-2xl p-4 sm:p-5 shadow-xl space-y-3 sm:space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-xs sm:text-sm font-bold text-white uppercase tracking-wider">
              {t('recentMatchesTitle')}
            </h2>
            <p className="text-[11px] sm:text-xs text-slate-400">
              {t('historySub')}
            </p>
          </div>
          <Link
            href="/history"
            className="text-xs text-cyan-400 hover:text-cyan-300 font-bold flex items-center gap-1 shrink-0"
          >
            <span>{t('viewAllLogs')}</span>
            <ArrowUpRight className="w-3.5 h-3.5" />
          </Link>
        </div>

        {/* Mobile View: Cards */}
        <div className="md:hidden space-y-2.5">
          {recentMatches.length > 0 ? (
            recentMatches.map((log) => {
              const isTandaTindakan = log.statusMatch === 'EXACT' || log.action.includes('Tanda Tindakan');
              return (
                <div key={log.id} className="p-3 rounded-xl bg-slate-950/80 border border-slate-800 space-y-2">
                  <div className="flex items-center justify-between">
                    <span
                      className={`inline-flex items-center justify-center w-20 px-2 py-0.5 rounded text-[9px] font-bold uppercase ${
                        log.type === 'DETECTION'
                          ? 'bg-blue-950 text-blue-400 border border-blue-800'
                          : 'bg-purple-950 text-purple-400 border border-purple-800'
                      }`}
                    >
                      {log.type}
                    </span>
                    <span className="text-[10px] font-mono text-slate-500">
                      {formatDate(log.timestamp)}
                    </span>
                  </div>
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <span className="inline-flex items-center justify-center w-24 font-mono font-black text-xs text-cyan-400 bg-slate-900 px-2 py-0.5 rounded border border-cyan-900/50">
                        {log.plate || 'N/A'}
                      </span>
                      {isTandaTindakan && (
                        <span className="inline-flex items-center justify-center min-w-[120px] px-2.5 py-0.5 rounded text-[9px] font-black uppercase bg-cyan-950 text-cyan-300 border border-cyan-700 whitespace-nowrap shadow-sm">
                          TANDA TINDAKAN
                        </span>
                      )}
                    </div>
                    {role !== 'USER' && (
                      <span className="text-[10px] font-mono text-slate-400">{log.userRole}</span>
                    )}
                  </div>
                  <p className="text-xs text-slate-300 font-medium">{log.note || log.details}</p>
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
                          {log.plate || 'N/A'}
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
