import React from 'react';
import Svg, { Circle, Path } from 'react-native-svg';

/** Lucide `WifiCog` — connectivity indicator glyph. */
export function WifiCogIcon({ size = 22, color = '#fff' }: { size?: number; color?: string }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path d="m14.305 19.53.923-.382" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
      <Path d="m15.228 16.852-.923-.383" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
      <Path d="m16.852 15.228-.383-.923" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
      <Path d="m16.852 20.772-.383.924" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
      <Path d="m19.148 15.228.383-.923" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
      <Path d="m19.53 21.696-.382-.924" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
      <Path d="M2 7.82a15 15 0 0 1 20 0" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
      <Path d="m20.772 16.852.924-.383" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
      <Path d="m20.772 19.148.924.383" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
      <Path d="M5 11.858a10 10 0 0 1 11.5-1.785" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
      <Path d="M8.5 15.429a5 5 0 0 1 2.413-1.31" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
      <Circle cx="18" cy="18" r="3" stroke={color} strokeWidth={2} />
    </Svg>
  );
}
