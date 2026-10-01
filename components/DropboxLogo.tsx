import React from 'react';
import Svg, { Path } from 'react-native-svg';

/** Dropbox open-box mark in brand blue. */
export function DropboxLogo({ size = 20 }: { size?: number }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      <Path
        fill="#0061FF"
        d="M6 2L12 6L6 10L0 6L6 2ZM18 2L24 6L18 10L12 6L18 2ZM0 14L6 10L12 14L6 18L0 14ZM18 10L24 14L18 18L12 14L18 10ZM6 19L12 15L18 19L12 23L6 19Z"
      />
    </Svg>
  );
}
