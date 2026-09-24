import { useEffect, useState } from 'react';

/**
 * H5 / 移动端断点。
 * 必须与 styles/global.css 中的 `@media (max-width: 768px)` 保持一致，
 * 避免出现「CSS 已切移动端、JS 仍按桌面端渲染」的错位。
 */
export const MOBILE_QUERY = '(max-width: 768px)';

function match(): boolean {
  if (typeof window === 'undefined' || !window.matchMedia) return false;
  return window.matchMedia(MOBILE_QUERY).matches;
}

/**
 * 监听视口宽度，返回当前是否为 H5 / 移动端。
 * 用于决定是否用 Drawer 承载导航与目录（移动端没有侧边栏空间）。
 */
export function useIsMobile(): boolean {
  const [isMobile, setIsMobile] = useState(match);

  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const mql = window.matchMedia(MOBILE_QUERY);
    const onChange = (e: MediaQueryListEvent) => setIsMobile(e.matches);
    setIsMobile(mql.matches);
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, []);

  return isMobile;
}
