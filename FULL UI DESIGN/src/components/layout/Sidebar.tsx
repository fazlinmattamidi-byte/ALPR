'use client';

import React, { useState, useEffect } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useLanguage } from '@/context/LanguageContext';
import { useAuth } from '@/context/AuthContext';
import {
  type LucideIcon,
  LayoutDashboard,
  Camera,
  Search,
  Car,
  Users,
  History,
  Settings,
  User,
  PanelLeftClose,
  PanelLeftOpen,
} from 'lucide-react';
import { cn } from '@/lib/utils';

type NavItem = {
  label: string;
  href: string;
  icon: LucideIcon;
  adminOnly?: boolean;
  badge?: string;
};

export const Sidebar: React.FC = () => {
  const pathname = usePathname();
  const { t } = useLanguage();
  const { role } = useAuth();
  const [isCollapsed, setIsCollapsed] = useState(false);

  useEffect(() => {
    const savedState = localStorage.getItem('sidebar_collapsed');
    if (savedState !== null) {
      queueMicrotask(() => setIsCollapsed(savedState === 'true'));
    }

    const handleToggle = () => {
      setIsCollapsed((prev) => {
        const next = !prev;
        localStorage.setItem('sidebar_collapsed', String(next));
        return next;
      });
    };

    window.addEventListener('toggle-sidebar', handleToggle);
    return () => window.removeEventListener('toggle-sidebar', handleToggle);
  }, []);

  const toggleCollapse = () => {
    setIsCollapsed((prev) => {
      const next = !prev;
      localStorage.setItem('sidebar_collapsed', String(next));
      return next;
    });
  };

  const navItems: NavItem[] = [
    { label: t('navDashboard'), href: '/', icon: LayoutDashboard },
    { label: t('navScanner'), href: '/scanner', icon: Camera },
    { label: t('navSearch'), href: '/search', icon: Search },
    { label: t('navHistory'), href: '/history', icon: History },
    { label: t('navVehicles'), href: '/vehicles', icon: Car },
    { label: t('navUsers'), href: '/users', icon: Users, adminOnly: true },
    { label: t('navSettings'), href: '/settings', icon: Settings },
    { label: t('navProfile'), href: '/profile', icon: User },
  ];

  if (pathname === '/login') return null;

  return (
    <aside
      className={cn(
        'app-sidebar hidden lg:flex flex-col border-r border-slate-800/80 bg-slate-950/80 backdrop-blur-md min-h-[calc(100vh-57px)] p-3 shrink-0 justify-between transition-all duration-300 ease-in-out sticky top-[57px] self-start',
        isCollapsed ? 'w-20' : 'w-64'
      )}
    >
      <div className="space-y-2">
        {/* Sidebar Header & Collapse Toggle */}
        <div
          className={cn(
            'flex items-center justify-between px-2 py-1.5 text-slate-400 border-b border-slate-800/60 pb-2 mb-1',
            isCollapsed && 'justify-center'
          )}
        >
          {!isCollapsed && (
            <span className="text-[10px] font-bold uppercase tracking-widest text-slate-400">
              {t('navMenuHeader')}
            </span>
          )}
          <button
            onClick={toggleCollapse}
            className="p-1 rounded-lg bg-slate-900 border border-slate-800 text-slate-400 hover:text-cyan-400 hover:border-cyan-500/50 transition-all shrink-0"
            title={isCollapsed ? 'Expand Sidebar (Buka Menu)' : 'Collapse Sidebar (Tutup Menu)'}
          >
            {isCollapsed ? <PanelLeftOpen className="w-4 h-4" /> : <PanelLeftClose className="w-4 h-4" />}
          </button>
        </div>

        {/* Navigation Items */}
        {navItems
          .filter((item) => !(item.adminOnly && role === 'USER'))
          .map((item) => {
            const isActive = pathname === item.href;
            const Icon = item.icon;

            return (
              <Link
                key={item.href}
                href={item.href}
                title={isCollapsed ? item.label : undefined}
                className={cn(
                  'flex items-center rounded-xl font-medium text-sm transition-all duration-200 group relative',
                  isCollapsed ? 'justify-center py-3 px-2' : 'justify-between px-3.5 py-2.5',
                  isActive
                    ? 'bg-cyan-950 text-cyan-400 border border-cyan-500/30 shadow-md shadow-cyan-950/40'
                    : 'text-slate-400 hover:bg-slate-800/60 hover:text-slate-200'
                )}
              >
                <div className="flex items-center gap-3">
                  <Icon
                    className={cn(
                      'w-4 h-4 transition-transform group-hover:scale-110 shrink-0',
                      isActive ? 'text-cyan-400' : 'text-slate-400 group-hover:text-cyan-300'
                    )}
                  />
                  {!isCollapsed && <span className="truncate">{item.label}</span>}
                </div>

                {!isCollapsed && item.badge && (
                  <span className="text-[9px] font-black uppercase px-2 py-0.5 rounded-md bg-cyan-500/20 text-cyan-300 border border-cyan-400/30 animate-pulse">
                    {item.badge}
                  </span>
                )}

                {isCollapsed && item.badge && (
                  <span className="absolute top-1.5 right-1.5 w-2 h-2 rounded-full bg-cyan-400 animate-pulse shadow-[0_0_8px_#06B6D4]" />
                )}
              </Link>
            );
          })}
      </div>

      <div className="h-2" />
    </aside>
  );
};
