'use client';

import { useEffect } from 'react';

export function ServiceWorkerCleanup() {
  useEffect(() => {
    if ('serviceWorker' in navigator) {
      void navigator.serviceWorker
        .getRegistrations()
        .then((registrations) => {
          registrations.forEach((registration) => {
            void registration.unregister();
          });
        })
        .catch(() => undefined);
    }

    if (window.caches) {
      void caches
        .keys()
        .then((keys) => {
          keys.forEach((key) => {
            void caches.delete(key);
          });
        })
        .catch(() => undefined);
    }
  }, []);

  return null;
}
