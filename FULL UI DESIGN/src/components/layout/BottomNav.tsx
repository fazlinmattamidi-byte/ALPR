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
  const { t } = useLanguage();
  const { role } = useAuth();
  const [showMoreDrawer, setShowMoreDrawer] = useState(false);

  const mainTabs = [
    { label: t('navDashboard'), href: '/', icon: LayoutDashboard },
    { label: t('navSearch'), href: '/search', icon: Search },
    { label: t('navScanner'), href: '/scanner', icon: Camera, isScannerBtn: true },
    { label: t('navHistory'), href: '/history', icon: History },
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
      <nav className="lg:hidden fixed bottom-0 left-0 right-0 z-40 bg-slate-950/95 backdrop-blur-lg border-t border-cyan-900/40 px-1.5 sm:px-4 pt-1.5 pb-[max(0.5rem,env(safe-area-inset-bottom))] flex items-center justify-between shadow-2xl">
        {mainTabs.map((tab) => {
          const isActive = pathname === tab.href;
          const Icon = tab.icon;

          if (tab.isScannerBtn) {
            return (
              <Link
                key={tab.href}
                href={tab.href}
                className="relative -top-2.5 flex flex-col items-center group shrink-0 px-0.5"
              >
                <div className="w-11 h-11 rounded-full bg-cyan-600 p-0.5 shadow-xl shadow-cyan-500/30 group-active:scale-95 transition-transform border border-cyan-300/40 flex items-center justify-center">
                  <div className="w-full h-full rounded-full bg-slate-950 flex items-center justify-center">
                    <Camera className="w-4.5 h-4.5 text-cyan-400 animate-pulse" />
                  </div>
                </div>
                <span className="text-[8.5px] sm:text-[9.5px] font-bold text-cyan-400 mt-1 text-center leading-none whitespace-nowrap tracking-tighter">
                  {tab.label}
                </span>
              </Link>
            );
          }

          return (
            <Link
              key={tab.href}
              href={tab.href}
              className={cn(
                'flex flex-col items-center justify-center py-1 px-1 rounded-lg transition-colors flex-1 min-w-0',
                isActive ? 'text-cyan-400 font-bold' : 'text-slate-400 hover:text-slate-200'
              )}
            >
              <Icon className="w-4.5 h-4.5 shrink-0" />
              <span className="text-[8.5px] sm:text-[9.5px] leading-none mt-1 text-center whitespace-nowrap tracking-tighter">{tab.label}</span>
            </Link>
          );
        })}

        {/* More Drawer Button */}
        <button
          onClick={() => setShowMoreDrawer(true)}
          className={cn(
            'flex flex-col items-center justify-center py-1 px-1 rounded-lg text-slate-400 hover:text-slate-200 transition-colors flex-1 min-w-0'
          )}
        >
          <MoreHorizontal className="w-4.5 h-4.5 shrink-0" />
          <span className="text-[8.5px] sm:text-[9.5px] leading-none mt-1 text-center whitespace-nowrap tracking-tighter">{t('moreMenu')}</span>
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
