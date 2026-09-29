/**
 * Logo - 统一的项目标识
 *
 * 站内所有 aipack 品牌位（导航、页脚、包卡片等）统一使用该组件，
 * 资源来自 public/logo.png（由仓库根目录 image/logo.png 缩放生成），
 * 避免各处 emoji 与正式 logo 不一致。
 */

import type { CSSProperties } from 'react';

export interface LogoProps {
  /** 显示尺寸（正方形，单位 px） */
  size?: number;
  /** 圆角（单位 px），默认 6 */
  radius?: number;
  /** 额外样式 */
  style?: CSSProperties;
}

export default function Logo({ size = 28, radius = 6, style }: LogoProps) {
  return (
    <img
      src="/logo.png"
      alt="aipack logo"
      width={size}
      height={size}
      style={{ width: size, height: size, borderRadius: radius, ...style }}
    />
  );
}
