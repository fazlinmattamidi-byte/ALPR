'use client';

import React, { useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useLanguage } from '@/context/LanguageContext';
import { useAuth } from '@/context/AuthContext';
import {
  LayoutDashboard,
  Search,
  Camera,
  History,
  MoreHorizontal,
  Car,
  Users,
  Settings,
  User,
  X,
} from 'lucide-react';
import { cn } from '@/lib/utils';

export const BottomNav: React.FC = () => {
  const pathname = usePathname();
  const { language, t } = useLanguage();
  const { role } = useAuth();
  const [showMoreDrawer, setShowMoreDrawer] = useState(false);
  const isMalay = language === 'BM';

  const mainTabs = [
    { label: t('navDashboard'), shortLabel: isMalay ? 'Papan' : 'Home', href: '/', icon: LayoutDashboard },
    { label: t('navSearch'), shortLabel: isMalay ? 'Cari' : 'Search', href: '/search', icon: Search },
    { label: t('navScanner'), shortLabel: isMalay ? 'Imbas' : 'Scan', href: '/scanner', icon: Camera, isScannerBtn: true },
    { label: t('navHistory'), shortLabel: isMalay ? 'Audit' : 'Audit', href: '/history', icon: History },
  ];

  const moreItems = [
    { label: t('navVehicles'), href: '/vehicles', icon: Car },
    { label: t('navUsers'), href: '/users', icon: Users, adminOnly: true },
    { label: t('navSettings'), href: '/settings', icon: Settings },
    { label: t('navProfile'), href: '/profile', icon: User },
  ];

  if (pathname === '/login') return null;

  return (
    <>
      {/* Mobile Bottom Bar */}
      <nav className="lg:hidden fixed left-3 right-3 bottom-3 z-40 grid grid-cols-5 items-end gap-1 rounded-2xl border border-cyan-900/50 bg-slate-950/95 px-2 py-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] shadow-2xl backdrop-blur-lg sm:left-4 sm:right-4">
        {mainTabs.map((tab) => {
          const isActive = pathname === tab.href;
          const Icon = tab.icon;

          if (tab.isScannerBtn) {
            return (
              <Link
                key={tab.href}
                href={tab.href}
                aria-label={tab.label}
                className="w-full min-w-0 flex flex-col items-center justify-center rounded-xl py-1 text-cyan-400 transition-colors group"
              >
                <div className="w-9 h-9 rounded-full bg-cyan-600 p-0.5 shadow-lg shadow-cyan-500/25 group-active:scale-95 transition-transform border border-cyan-300/40 flex items-center justify-center">
                  <div className="w-full h-full rounded-full bg-slate-950 flex items-center justify-center">
                    <Camera className="w-4.5 h-4.5 text-cyan-400" />
                  </div>
                </div>
                <span className="mt-1 text-[10px] font-bold leading-none text-center whitespace-nowrap">
                  {tab.shortLabel}
                </span>
              </Link>
            );
          }

          return (
            <Link
              key={tab.href}
              href={tab.href}
              aria-label={tab.label}
              className={cn(
                'w-full min-w-0 flex flex-col items-center justify-center rounded-xl py-2 transition-colors',
                isActive ? 'bg-slate-900/80 text-cyan-400 font-bold' : 'text-slate-400 hover:text-slate-200'
              )}
            >
              <Icon className="w-4.5 h-4.5 shrink-0" />
              <span className="mt-1 text-[10px] leading-none text-center whitespace-nowrap">{tab.shortLabel}</span>
            </Link>
          );
        })}

        {/* More Drawer Button */}
        <button
          onClick={() => setShowMoreDrawer(true)}
          aria-label={t('moreMenu')}
          className={cn(
            'w-full min-w-0 flex flex-col items-center justify-center rounded-xl py-2 text-slate-400 hover:text-slate-200 transition-colors'
          )}
        >
          <MoreHorizontal className="w-4.5 h-4.5 shrink-0" />
          <span className="mt-1 text-[10px] leading-none text-center whitespace-nowrap">{t('moreMenu')}</span>
        </button>
      </nav>

      {/* More Options Drawer Popup */}
      {showMoreDrawer && (
        <div className="lg:hidden fixed inset-0 z-50 bg-slate-950/80 backdrop-blur-md flex flex-col justify-end">
          <div className="bg-slate-900 border-t border-cyan-800/50 rounded-t-2xl p-4 sm:p-5 space-y-4 max-h-[80vh] overflow-y-auto pb-[max(1.25rem,env(safe-area-inset-bottom))]">
            <div className="flex items-center justify-between border-b border-slate-800 pb-3">
              <span className="text-sm font-bold text-white uppercase tracking-wider">
                {t('moreMenu')}
              </span>
              <button
                onClick={() => setShowMoreDrawer(false)}
                className="p-1 rounded-lg bg-slate-800 text-slate-400 hover:text-white"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="grid grid-cols-2 gap-2.5 sm:gap-3">
              {moreItems
                .filter((item) => !(item.adminOnly && role === 'USER'))
                .map((item) => {
                  const Icon = item.icon;

                  return (
                    <Link
                      key={item.href}
                      href={item.href}
                      onClick={() => setShowMoreDrawer(false)}
                      className={cn(
                        'flex items-center gap-2.5 p-3 rounded-xl border transition-all',
                        pathname === item.href
                          ? 'bg-cyan-950/80 border-cyan-500/40 text-cyan-400 font-bold'
                          : 'bg-slate-800/60 border-slate-700/60 text-slate-200 hover:bg-slate-800'
                      )}
                    >
                      <Icon className="w-4 h-4 sm:w-5 sm:h-5 text-cyan-400 shrink-0" />
                      <span className="text-xs truncate">{item.label}</span>
                    </Link>
                  );
                })}
            </div>
          </div>
        </div>
      )}
    </>
  );
};
