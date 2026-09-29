'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

export default function CamerasPage() {
  const router = useRouter();

  useEffect(() => {
    router.replace('/scanner');
  }, [router]);

  return null;
}
