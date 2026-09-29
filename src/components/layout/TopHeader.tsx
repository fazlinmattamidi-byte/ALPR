'use client';

import React, { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useAuth } from '@/context/AuthContext';
import { useLanguage } from '@/context/LanguageContext';
import { useStorage } from '@/context/StorageContext';
import Image from 'next/image';
import {
  ChevronDown,
  Globe,
  Sun,
  Moon,
  User as UserIcon,
  Settings,
  LogOut,
} from 'lucide-react';

import { usePathname } from 'next/navigation';

export const TopHeader: React.FC = () => {
  const pathname = usePathname();
  const { currentUser, logout } = useAuth();
  const { language, setLanguage, t } = useLanguage();
  const { theme, setTheme } = useStorage();
  const [isProfileOpen, setIsProfileOpen] = useState(false);
  const profileMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handlePointerDown = (event: PointerEvent) => {
      if (!profileMenuRef.current?.contains(event.target as Node)) {
        setIsProfileOpen(false);
      }
    };

    window.addEventListener('pointerdown', handlePointerDown);
    return () => window.removeEventListener('pointerdown', handlePointerDown);
  }, []);

  if (pathname === '/login') return null;

  return (
    <header className="app-header sticky top-0 z-40 w-full backdrop-blur-md bg-slate-900/90 border-b border-cyan-900/40 px-4 sm:px-5 py-2.5 shadow-lg">
      <div className="max-w-[1480px] mx-auto flex items-center justify-between gap-3 sm:gap-4">
        {/* Brand & Subtitle */}
        <div className="flex items-center gap-2 sm:gap-3 shrink-0">

          <Link href="/" className="flex items-center gap-2.5 group">
            <div className="mode-logo-frame w-9 h-9 sm:w-10 sm:h-10 rounded-xl bg-slate-950 flex items-center justify-center shadow-lg shadow-cyan-500/20 group-hover:scale-105 transition-all duration-300 border border-cyan-400/40 overflow-hidden shrink-0">
              <Image
                src="/logo.png"
                alt="TRACK Logo"
                width={40}
                height={40}
                className="mode-logo-image w-full h-full object-cover"
                priority
              />
            </div>
            <div>
              <div className="flex items-center gap-1.5">
                <span className="text-xl font-black tracking-wider text-white">
                  TRACK
                </span>
              </div>
              <p className="text-[11px] text-slate-400 hidden sm:block font-medium">
                {t('appSubName')}
              </p>
            </div>
          </Link>
        </div>

        {/* Controls: Language, Theme, Profile Menu */}
        <div className="flex items-center gap-1.5 sm:gap-2.5">
          {/* Language Switcher */}
          <button
            onClick={() => setLanguage(language === 'BM' ? 'EN' : 'BM')}
            className="h-8 sm:h-9 flex items-center gap-1 px-2 sm:px-2.5 rounded-lg bg-slate-800/80 hover:bg-slate-700/80 text-slate-300 text-[11px] sm:text-xs font-semibold border border-slate-700/60 transition-all shrink-0"
            title="Toggle Language"
          >
            <Globe className="w-3.5 h-3.5 text-cyan-400 shrink-0" />
            <span>{language}</span>
          </button>

          {/* Theme Switcher */}
          <button
            onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
            className="h-8 w-8 sm:h-9 sm:w-9 rounded-lg bg-slate-800/80 hover:bg-slate-700/80 text-slate-300 border border-slate-700/60 transition-all shrink-0 flex items-center justify-center"
            title="Toggle Theme"
          >
            {theme === 'dark' ? (
              <Sun className="w-3.5 h-3.5 sm:w-4 sm:h-4 text-amber-400" />
            ) : (
              <Moon className="w-3.5 h-3.5 sm:w-4 sm:h-4 text-cyan-400" />
            )}
          </button>

          {/* Profile Dropdown */}
          <div ref={profileMenuRef} className="relative">
            <button
              type="button"
              onClick={() => setIsProfileOpen((open) => !open)}
              className="h-8 sm:h-9 px-2 sm:px-2.5 rounded-lg bg-slate-800/80 hover:bg-slate-700/80 text-slate-300 border border-slate-700/60 transition-all flex items-center gap-1.5 shrink-0"
              title="Profile menu"
              aria-expanded={isProfileOpen}
            >
              <UserIcon className="w-3.5 h-3.5 sm:w-4 sm:h-4 text-cyan-400" />
              <ChevronDown className="w-3 h-3 text-slate-500 hidden sm:block" />
            </button>

            {isProfileOpen && (
              <div className="absolute right-0 top-full mt-2 w-52 rounded-xl border border-slate-800 bg-slate-950/98 shadow-2xl shadow-slate-950/60 overflow-hidden z-50">
                <div className="px-3 py-2.5 border-b border-slate-800">
                  <div className="text-xs font-bold text-white truncate">
                    {currentUser?.name || 'Officer User'}
                  </div>
                  <div className="text-[10px] text-slate-500 truncate">
                    {currentUser?.email || 'officer@track.my'}
                  </div>
                </div>
                <Link
                  href="/profile"
                  onClick={() => setIsProfileOpen(false)}
                  className="flex items-center gap-2 px-3 py-2.5 text-xs font-bold text-slate-300 hover:bg-slate-900 hover:text-cyan-300 transition-colors"
                >
                  <UserIcon className="w-4 h-4 text-cyan-400" />
                  <span>{t('navProfile')}</span>
                </Link>
                <Link
                  href="/settings"
                  onClick={() => setIsProfileOpen(false)}
                  className="flex items-center gap-2 px-3 py-2.5 text-xs font-bold text-slate-300 hover:bg-slate-900 hover:text-cyan-300 transition-colors"
                >
                  <Settings className="w-4 h-4 text-cyan-400" />
                  <span>{t('navSettings')}</span>
                </Link>
                <button
                  onClick={() => {
                    setIsProfileOpen(false);
                    logout();
                  }}
                  className="w-full flex items-center gap-2 px-3 py-2.5 text-xs font-bold text-red-300 hover:bg-red-950/60 transition-colors"
                >
                  <LogOut className="w-4 h-4 text-red-400" />
                  <span>{t('navLogout')}</span>
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
    </header>
  );
};
