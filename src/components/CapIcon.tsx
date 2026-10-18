/** 能力图标（与灵境仪表盘共用）。纯 SVG，随 currentColor 着色。 */
export function CapIcon({ name, size = 20 }: { name: string; size?: number }) {
  const c = {
    width: size, height: size, viewBox: '0 0 24 24', fill: 'none',
    stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const,
  };
  switch (name) {
    case 'travel': return <svg {...c}><path d="M12 21s-6-5.3-6-10a6 6 0 1 1 12 0c0 4.7-6 10-6 10z" /><circle cx="12" cy="11" r="2.2" /></svg>;
    case 'schedule': return <svg {...c}><rect x="3.5" y="4.5" width="17" height="16" rx="2.5" /><path d="M3.5 9h17M8 2.5v4M16 2.5v4M8 13h4" /></svg>;
    case 'relax': return <svg {...c}><path d="M20 14.5A8 8 0 1 1 9.5 4a6.2 6.2 0 0 0 10.5 10.5z" /></svg>;
    case 'health': return <svg {...c}><path d="M12 20s-7-4.4-7-9.3A4 4 0 0 1 12 8a4 4 0 0 1 7 2.7C19 15.6 12 20 12 20z" /></svg>;
    case 'learn': return <svg {...c}><path d="M9 18h5M10 21h4M12 3a6 6 0 0 0-3.5 10.9c.6.5 1 1.2 1 2V17h5v-1.1c0-.8.4-1.5 1-2A6 6 0 0 0 12 3z" /></svg>;
    case 'chat': return <svg {...c}><path d="M4 5.5h16v11H9l-5 4z" /><path d="M8 10h8M8 13h5" /></svg>;
    case 'save': return <svg {...c}><circle cx="12" cy="12" r="8.5" /><path d="M12 7.5v9M9 12h6" /></svg>;
    case 'write': return <svg {...c}><path d="M4 20l4-1 11-11-3-3L5 16z" /><path d="M14 6l3 3" /></svg>;
    default: return <svg {...c}><circle cx="12" cy="12" r="8.5" /></svg>;
  }
}
