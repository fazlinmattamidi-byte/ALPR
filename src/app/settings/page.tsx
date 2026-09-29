'use client';

import React from 'react';
import { useStorage } from '@/context/StorageContext';
import { useLanguage } from '@/context/LanguageContext';
import {
  Sun,
  Moon,
  Volume2,
} from 'lucide-react';

export default function SettingsPage() {
  const { settings, updateSettings, theme, setTheme } = useStorage();
  const { language, setLanguage, t } = useLanguage();

  return (
    <div className="max-w-3xl mx-auto space-y-4 sm:space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-black text-white tracking-wide leading-tight">
          {t('settingsTitle')}
        </h1>
      </div>

      {/* Language & Theme Card */}
      <div className="bg-slate-900/90 border border-slate-800 rounded-2xl p-4 sm:p-5 shadow-xl space-y-4 sm:space-y-5">
        <h2 className="text-xs sm:text-sm font-bold text-white uppercase tracking-wider border-b border-slate-800 pb-3 leading-tight">
          {t('localizationAndDisplay')}
        </h2>

        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 md:gap-4">
          {/* Language Selector */}
          <div className="space-y-2">
            <label className="block text-[11px] sm:text-xs font-semibold text-slate-300">
              {t('languageSetting')}
            </label>
            <div className="grid grid-cols-2 gap-2">
              <button
                onClick={() => setLanguage('BM')}
                className={`py-2.5 sm:py-2 px-3 rounded-xl border text-xs font-bold transition-all ${
                  language === 'BM'
                    ? 'bg-cyan-950 text-cyan-300 border-cyan-500/60 shadow-sm'
                    : 'bg-slate-950 border-slate-800 text-slate-400 hover:text-white'
                }`}
              >
                <span className="sm:hidden">BM</span>
                <span className="hidden sm:inline">Bahasa Melayu (BM)</span>
              </button>
              <button
                onClick={() => setLanguage('EN')}
                className={`py-2.5 sm:py-2 px-3 rounded-xl border text-xs font-bold transition-all ${
                  language === 'EN'
                    ? 'bg-cyan-950 text-cyan-300 border-cyan-500/60 shadow-sm'
                    : 'bg-slate-950 border-slate-800 text-slate-400 hover:text-white'
                }`}
              >
                <span className="sm:hidden">EN</span>
                <span className="hidden sm:inline">English (EN)</span>
              </button>
            </div>
          </div>

          {/* Theme Selector */}
          <div className="space-y-2">
            <label className="block text-[11px] sm:text-xs font-semibold text-slate-300">
              {t('themeSetting')}
            </label>
            <div className="grid grid-cols-2 gap-2">
              <button
                onClick={() => setTheme('dark')}
                className={`py-2.5 sm:py-2 px-3 rounded-xl border text-xs font-bold flex items-center justify-center gap-2 transition-all ${
                  theme === 'dark'
                    ? 'bg-cyan-950 text-cyan-300 border-cyan-500/60 shadow-sm'
                    : 'bg-slate-950 border-slate-800 text-slate-400 hover:text-white'
                }`}
              >
                <Moon className="w-4 h-4 text-cyan-400" />
                <span>{t('darkModeLabel')}</span>
              </button>

              <button
                onClick={() => setTheme('light')}
                className={`py-2.5 sm:py-2 px-3 rounded-xl border text-xs font-bold flex items-center justify-center gap-2 transition-all ${
                  theme === 'light'
                    ? 'bg-cyan-950 text-cyan-300 border-cyan-500/60 shadow-sm'
                    : 'bg-slate-950 border-slate-800 text-slate-400 hover:text-white'
                }`}
              >
                <Sun className="w-4 h-4 text-amber-400" />
                <span>{t('lightModeLabel')}</span>
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* System Sound Notification */}
      <div className="bg-slate-900/90 border border-slate-800 rounded-2xl p-4 sm:p-5 shadow-xl space-y-3 sm:space-y-4">
        <h2 className="text-xs sm:text-sm font-bold text-white uppercase tracking-wider border-b border-slate-800 pb-3 leading-tight">
          {t('systemAlertsHeader')}
        </h2>

        <div className="flex items-center justify-between gap-4 p-3 rounded-xl bg-slate-950 border border-slate-800">
          <div className="flex min-w-0 items-center gap-3">
            <Volume2 className="w-4 h-4 text-cyan-400" />
            <div className="min-w-0">
              <div className="text-xs font-bold text-white">{t('soundAlertSetting')}</div>
              <div className="line-clamp-2 text-[11px] leading-snug text-slate-400">{t('soundAlertSub')}</div>
            </div>
          </div>
          <input
            type="checkbox"
            checked={settings.soundAlerts}
            onChange={(e) => updateSettings({ soundAlerts: e.target.checked })}
            className="w-4 h-4 accent-cyan-400 cursor-pointer"
          />
        </div>

      </div>

      {/* About & Version Info Card */}
      <div className="bg-slate-900/90 border border-slate-800 rounded-2xl p-4 sm:p-5 shadow-xl space-y-3 sm:space-y-4">
        <h2 className="text-xs sm:text-sm font-bold text-white uppercase tracking-wider border-b border-slate-800 pb-3 leading-tight">
          {t('versionInfo')}
        </h2>

        <div className="space-y-2.5 text-xs text-slate-300 font-mono">
          <div className="flex items-start justify-between gap-3">
            <span className="text-slate-400">{t('softwareNameLabel')}</span>
            <span className="text-right font-bold text-white">TRACK</span>
          </div>
          <div className="flex items-start justify-between gap-3">
            <span className="text-slate-400">{t('engineVersionLabel')}</span>
            <span className="text-right text-cyan-400 font-bold">v2.4.0</span>
          </div>
          <div className="flex items-start justify-between gap-3">
            <span className="text-slate-400">{t('pwaStatusLabel')}</span>
            <span className="text-right text-emerald-400 font-bold">{t('pwaStatusValue')}</span>
          </div>
        </div>
      </div>
    </div>
  );
}
