'use client';

import React from 'react';
import { useStorage } from '@/context/StorageContext';
import { useLanguage } from '@/context/LanguageContext';
import {
  Settings,
  Globe,
  Sun,
  Moon,
  Sliders,
  Volume2,
  Info,
} from 'lucide-react';

export default function SettingsPage() {
  const { settings, updateSettings, theme, setTheme } = useStorage();
  const { language, setLanguage, t } = useLanguage();

  return (
    <div className="max-w-3xl mx-auto space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-black text-white tracking-wide">
          {t('settingsTitle')}
        </h1>
      </div>

      {/* Language & Theme Card */}
      <div className="bg-slate-900/90 border border-slate-800 rounded-2xl p-5 shadow-xl space-y-5">
        <h2 className="text-sm font-bold text-white uppercase tracking-wider border-b border-slate-800 pb-3">
          {t('localizationAndDisplay')}
        </h2>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {/* Language Selector */}
          <div className="space-y-2">
            <label className="block text-xs font-semibold text-slate-300">
              {t('languageSetting')}
            </label>
            <div className="grid grid-cols-2 gap-2">
              <button
                onClick={() => setLanguage('BM')}
                className={`py-2 px-3 rounded-xl border text-xs font-bold transition-all ${
                  language === 'BM'
                    ? 'bg-cyan-950 text-cyan-300 border-cyan-500/60 shadow-sm'
                    : 'bg-slate-950 border-slate-800 text-slate-400 hover:text-white'
                }`}
              >
                Bahasa Melayu (BM)
              </button>
              <button
                onClick={() => setLanguage('EN')}
                className={`py-2 px-3 rounded-xl border text-xs font-bold transition-all ${
                  language === 'EN'
                    ? 'bg-cyan-950 text-cyan-300 border-cyan-500/60 shadow-sm'
                    : 'bg-slate-950 border-slate-800 text-slate-400 hover:text-white'
                }`}
              >
                English (EN)
              </button>
            </div>
          </div>

          {/* Theme Selector */}
          <div className="space-y-2">
            <label className="block text-xs font-semibold text-slate-300">
              {t('themeSetting')}
            </label>
            <div className="grid grid-cols-2 gap-2">
              <button
                onClick={() => setTheme('dark')}
                className={`py-2 px-3 rounded-xl border text-xs font-bold flex items-center justify-center gap-2 transition-all ${
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
                className={`py-2 px-3 rounded-xl border text-xs font-bold flex items-center justify-center gap-2 transition-all ${
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
      <div className="bg-slate-900/90 border border-slate-800 rounded-2xl p-5 shadow-xl space-y-4">
        <h2 className="text-sm font-bold text-white uppercase tracking-wider border-b border-slate-800 pb-3">
          {t('systemAlertsHeader')}
        </h2>

        <div className="flex items-center justify-between p-3 rounded-xl bg-slate-950 border border-slate-800">
          <div className="flex items-center gap-2.5">
            <Volume2 className="w-4 h-4 text-cyan-400" />
            <div>
              <div className="text-xs font-bold text-white">{t('soundAlertSetting')}</div>
              <div className="text-[10px] text-slate-400">{t('soundAlertSub')}</div>
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
      <div className="bg-slate-900/90 border border-slate-800 rounded-2xl p-5 shadow-xl space-y-3">
        <h2 className="text-sm font-bold text-white uppercase tracking-wider border-b border-slate-800 pb-3">
          {t('versionInfo')}
        </h2>

        <div className="space-y-2 text-xs text-slate-300 font-mono">
          <div className="flex justify-between">
            <span className="text-slate-400">{t('softwareNameLabel')}</span>
            <span className="font-bold text-white">TRACK (ANPR PWA)</span>
          </div>
          <div className="flex justify-between">
            <span className="text-slate-400">{t('engineVersionLabel')}</span>
            <span className="text-cyan-400 font-bold">v2.4.0-PROD (Phase 1 Ready)</span>
          </div>
          <div className="flex justify-between">
            <span className="text-slate-400">{t('pwaStatusLabel')}</span>
            <span className="text-emerald-400 font-bold">{t('pwaStatusValue')}</span>
          </div>
        </div>
      </div>
    </div>
  );
}
