import { useState, useEffect, useCallback } from 'react';
import { Routes, Route } from 'react-router-dom';

import { CustomerPage } from './pages/CustomerPage';
import { StarField } from './components/StarField';

type Accent = 'nebula' | 'warm';

function getInitialTheme(): 'light' | 'dark' {
  if (typeof window === 'undefined') return 'dark';
  const saved = window.localStorage.getItem('theme');
  if (saved === 'light' || saved === 'dark') return saved;
  return 'dark';
}
function getInitialAccent(): Accent {
  if (typeof window === 'undefined') return 'nebula';
  const saved = window.localStorage.getItem('accent');
  if (saved === 'nebula' || saved === 'warm') return saved;
  return 'nebula';
}
function getInitialLite(): boolean {
  if (typeof window === 'undefined') return false;
  const saved = window.localStorage.getItem('lite');
  if (saved === '1') return true;
  if (saved === '0') return false;
  // 自动：低端设备 / 偏好减少动效 → 默认开启性能 lite
  const low =
    (navigator.hardwareConcurrency || 8) <= 4 ||
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  return low;
}

export default function App() {
  const [theme, setTheme] = useState<'light' | 'dark'>(getInitialTheme);
  const [accent, setAccent] = useState<Accent>(getInitialAccent);
  const [lite, setLite] = useState<boolean>(getInitialLite);

  useEffect(() => {
    const root = document.documentElement;
    root.classList.toggle('dark', theme === 'dark');
    root.classList.toggle('light', theme === 'light');
    root.classList.toggle('warm', accent === 'warm');
    root.classList.toggle('lite', lite);
    window.localStorage.setItem('theme', theme);
    window.localStorage.setItem('accent', accent);
    window.localStorage.setItem('lite', lite ? '1' : '0');
  }, [theme, accent, lite]);

  const toggleTheme = useCallback(() => setTheme((t) => (t === 'dark' ? 'light' : 'dark')), []);
  const toggleAccent = useCallback(() => setAccent((a) => (a === 'warm' ? 'nebula' : 'warm')), []);
  const toggleLite = useCallback(() => setLite((v) => !v), []);

  return (
    <>
      <StarField lite={lite} accent={accent} />
      <Routes>
        {/* 客户对话（关系界面） */}
        <Route
          path="/"
          element={
            <CustomerPage
              theme={theme}
              onToggleTheme={toggleTheme}
              accent={accent}
              onToggleAccent={toggleAccent}
              lite={lite}
              onToggleLite={toggleLite}
            />
          }
        />
      </Routes>
    </>
  );
}
