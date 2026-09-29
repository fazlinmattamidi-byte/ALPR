'use client';

import React, { createContext, useContext, useEffect, useState } from 'react';
import { Language } from '@/types';
import { dictionary } from '@/lib/dictionary';

interface LanguageContextType {
  language: Language;
  setLanguage: (lang: Language) => void;
  t: (key: string) => string;
}

const LanguageContext = createContext<LanguageContextType | undefined>(undefined);

function readStoredLanguage(): Language {
  if (typeof window === 'undefined') return 'BM';
  const saved = localStorage.getItem('track_language');
  return saved === 'BM' || saved === 'EN' ? saved : 'BM';
}

export const LanguageProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [language, setLanguageState] = useState<Language>('BM');

  useEffect(() => {
    const id = window.setTimeout(() => {
      setLanguageState(readStoredLanguage());
    }, 0);

    return () => window.clearTimeout(id);
  }, []);

  const setLanguage = (lang: Language) => {
    setLanguageState(lang);
    localStorage.setItem('track_language', lang);
  };

  const t = (key: string): string => {
    return dictionary[language]?.[key] || dictionary.BM[key] || key;
  };

  return (
    <LanguageContext.Provider value={{ language, setLanguage, t }}>
      {children}
    </LanguageContext.Provider>
  );
};

export const useLanguage = () => {
  const context = useContext(LanguageContext);
  if (!context) {
    throw new Error('useLanguage must be used within a LanguageProvider');
  }
  return context;
};
